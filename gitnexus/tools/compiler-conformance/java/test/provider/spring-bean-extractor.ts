import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  collectJavaCaptureSideChannel,
  type JavaCaptureSideChannel,
} from '../../../../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../../../../src/core/ingestion/languages/java/captures.js';
import { javaScopeResolver } from '../../../../../src/core/ingestion/languages/java/scope-resolver.js';

function captureClassAnnotations(code: string): JavaCaptureSideChannel['classAnnotations'] {
  const filePath = 'src/Test.java';
  emitJavaScopeCaptures(code, filePath);
  return collectJavaCaptureSideChannel(filePath)?.classAnnotations ?? [];
}

function captureSpringDiFacts(code: string): NonNullable<JavaCaptureSideChannel['springDiFacts']> {
  const filePath = 'src/Test.java';
  emitJavaScopeCaptures(code, filePath);
  return collectJavaCaptureSideChannel(filePath)?.springDiFacts ?? [];
}

describe('Java class annotation capture', () => {
  it('collects annotation names during the existing scope-query traversal', () => {
    const facts = captureClassAnnotations(`
      @Component("widget") class Widget {
        @Deprecated @Service static class BillingService {}
      }
      @org.springframework.context.annotation.Configuration class AppConfiguration {}

      @Service interface ServiceContract {}
      @Service enum ServiceState { READY }
      @Service record ServiceRecord(String value) {}
      @Service @interface ServiceMarker {}
    `);

    assert.deepEqual(
      facts.map((fact) => fact.annotationNames),
      [
        ['Component'],
        ['Deprecated', 'Service'],
        ['org.springframework.context.annotation.Configuration'],
      ],
    );
  });

  it('clears worker side-channel facts at the start of each workspace pass', async () => {
    const filePath = 'src/Stale.java';
    emitJavaScopeCaptures('@Service class Stale {}', filePath);
    assert.equal((collectJavaCaptureSideChannel(filePath)?.classAnnotations).length, 1);

    await javaScopeResolver.loadResolutionConfig?.('/tmp/repo');

    assert.equal(collectJavaCaptureSideChannel(filePath), undefined);
  });
});

describe('Java Spring injection syntax capture', () => {
  it('preserves constructor, field, method, qualifier, and bean-name syntax in the side channel', () => {
    const facts = captureSpringDiFacts(`
      @Service("checkout") class Checkout {
        Checkout(@Qualifier("fastGateway") Gateway gateway) {}
        @Autowired Gateway fallback;
        @Inject void setRepo(Repo repo) {}
      }
    `);

    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0].classAnnotations, [
      { name: 'Service', text: '@Service("checkout")', line: 2 },
    ]);
    assert.partialDeepStrictEqual(facts[0].injectionSites, [
      {
        kind: 'constructor',
        implicitConstructor: true,
        dependencies: [
          {
            name: 'gateway',
            rawType: 'Gateway',
            annotations: [{ name: 'Qualifier', text: '@Qualifier("fastGateway")' }],
          },
        ],
      },
      {
        kind: 'field',
        memberName: 'fallback',
        dependencies: [{ name: 'fallback', rawType: 'Gateway' }],
      },
      {
        kind: 'method',
        memberName: 'setRepo',
        dependencies: [{ name: 'repo', rawType: 'Repo' }],
      },
    ]);
  });
});
