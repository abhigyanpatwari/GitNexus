import { describe, expect, it } from 'vitest';
import {
  collectJavaCaptureSideChannel,
  type JavaCaptureSideChannel,
} from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { emitJavaScopeCaptures } from '../../src/core/ingestion/languages/java/captures.js';
import { javaScopeResolver } from '../../src/core/ingestion/languages/java/scope-resolver.js';
import { deriveSpringBeanMetadata } from '../../src/core/ingestion/frameworks/spring/bean-catalog.js';
import {
  collectKotlinCaptureSideChannel,
  type KotlinCaptureSideChannel,
} from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import { kotlinScopeResolver } from '../../src/core/ingestion/languages/kotlin/scope-resolver.js';

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

    expect(facts.map((fact) => fact.annotationNames)).toEqual([
      ['Component'],
      ['Deprecated', 'Service'],
      ['org.springframework.context.annotation.Configuration'],
    ]);
  });

  it('clears worker side-channel facts at the start of each workspace pass', async () => {
    const filePath = 'src/Stale.java';
    emitJavaScopeCaptures('@Service class Stale {}', filePath);
    expect(collectJavaCaptureSideChannel(filePath)?.classAnnotations).toHaveLength(1);

    await javaScopeResolver.loadResolutionConfig?.('/tmp/repo');

    expect(collectJavaCaptureSideChannel(filePath)).toBeUndefined();
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

    expect(facts).toHaveLength(1);
    expect(facts[0].classAnnotations).toEqual([{ name: 'Service', text: '@Service("checkout")' }]);
    expect(facts[0].injectionSites).toMatchObject([
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

function captureKotlinClassAnnotations(code: string): KotlinCaptureSideChannel['classAnnotations'] {
  const filePath = 'src/Test.kt';
  emitKotlinScopeCaptures(code, filePath);
  return collectKotlinCaptureSideChannel(filePath)?.classAnnotations ?? [];
}

function captureKotlinSpringDiFacts(
  code: string,
): NonNullable<KotlinCaptureSideChannel['springDiFacts']> {
  const filePath = 'src/Test.kt';
  emitKotlinScopeCaptures(code, filePath);
  return collectKotlinCaptureSideChannel(filePath)?.springDiFacts ?? [];
}

describe('Kotlin class annotation capture', () => {
  it('captures supported class forms and excludes non-candidate declarations', () => {
    const facts = captureKotlinClassAnnotations(`
      @Component class Widget
      @Service("billing") data class BillingService(val name: String)
      @org.springframework.context.annotation.Configuration sealed class AppConfiguration
      @Service value class ServiceId(val value: String)
      class Outer { @Service class NestedService }

      @Service interface ServiceContract
      @Service object ServiceObject
      @Service enum class ServiceState { READY }
      @Service annotation class ServiceMarker
    `);

    expect(facts.map((fact) => fact.annotationNames)).toEqual([
      ['Component'],
      ['Service'],
      ['org.springframework.context.annotation.Configuration'],
      ['Service'],
      ['Service'],
    ]);
  });

  it('clears annotation facts while preserving the Kotlin side-channel lifecycle', async () => {
    const filePath = 'src/Stale.kt';
    emitKotlinScopeCaptures('@Service class Stale', filePath);
    expect(collectKotlinCaptureSideChannel(filePath)?.classAnnotations).toHaveLength(1);

    await kotlinScopeResolver.loadResolutionConfig?.('/tmp/repo');

    expect(collectKotlinCaptureSideChannel(filePath)).toBeUndefined();
  });
});

describe('Kotlin Spring injection syntax capture', () => {
  it('preserves primary constructor, property, method, nullable type, projection, and use-site syntax', () => {
    const facts = captureKotlinSpringDiFacts(`
      @Service("checkout") @Primary
      class Checkout @Autowired constructor(
        @param:Qualifier("fastGateway") private val gateway: PaymentGateway,
        @Named("repo") repo: Repo?,
        val gateways: List<out PaymentGateway>,
      ) {
        @field:Autowired
        @field:Qualifier("slowGateway")
        lateinit var fallback: PaymentGateway

        @set:Inject
        var optional: Repo? = null

        @Inject
        fun setRepo(@Named("repo") repo: Repo) {}
      }
    `);

    expect(facts).toHaveLength(1);
    expect(facts[0].classAnnotations).toEqual([
      { name: 'Service', text: '@Service("checkout")' },
      { name: 'Primary', text: '@Primary' },
    ]);
    expect(facts[0].injectionSites).toMatchObject([
      {
        kind: 'constructor',
        implicitConstructor: false,
        dependencies: [
          {
            name: 'gateway',
            rawType: 'PaymentGateway',
            annotations: [
              {
                name: 'Qualifier',
                text: '@param:Qualifier("fastGateway")',
                useSiteTarget: 'param',
              },
            ],
          },
          {
            name: 'repo',
            rawType: 'Repo?',
            annotations: [{ name: 'Named', text: '@Named("repo")' }],
          },
          {
            name: 'gateways',
            rawType: 'List<out PaymentGateway>',
          },
        ],
      },
      {
        kind: 'property',
        memberName: 'fallback',
        annotations: [
          { name: 'Autowired', text: '@field:Autowired', useSiteTarget: 'field' },
          {
            name: 'Qualifier',
            text: '@field:Qualifier("slowGateway")',
            useSiteTarget: 'field',
          },
        ],
      },
      {
        kind: 'property',
        memberName: 'optional',
        annotations: [{ name: 'Inject', text: '@set:Inject', useSiteTarget: 'set' }],
      },
      {
        kind: 'method',
        memberName: 'setRepo',
        dependencies: [
          {
            name: 'repo',
            rawType: 'Repo',
            annotations: [{ name: 'Named', text: '@Named("repo")' }],
          },
        ],
      },
    ]);
  });

  it('captures sole stereotype primary constructors as implicit injection sites', () => {
    const facts = captureKotlinSpringDiFacts(`
      @Service
      class Checkout(private val gateway: PaymentGateway)
    `);

    expect(facts[0].injectionSites).toMatchObject([
      {
        kind: 'constructor',
        implicitConstructor: true,
        dependencies: [{ name: 'gateway', rawType: 'PaymentGateway' }],
      },
    ]);
  });
});

describe('deriveSpringBeanMetadata', () => {
  it('maps all supported canonical stereotypes to roles', () => {
    const cases = [
      ['org.springframework.stereotype.Component', 'component'],
      ['org.springframework.stereotype.Service', 'service'],
      ['org.springframework.stereotype.Repository', 'repository'],
      ['org.springframework.stereotype.Controller', 'controller'],
      ['org.springframework.web.bind.annotation.RestController', 'rest-controller'],
      ['org.springframework.context.annotation.Configuration', 'configuration'],
    ] as const;

    for (const [annotation, role] of cases) {
      expect(deriveSpringBeanMetadata([annotation])).toEqual({
        framework: 'spring',
        role,
        annotation,
      });
    }
  });

  it('omits conflicting or unsupported evidence', () => {
    expect(
      deriveSpringBeanMetadata([
        'org.springframework.stereotype.Service',
        'org.springframework.stereotype.Component',
      ]),
    ).toBeUndefined();
    expect(deriveSpringBeanMetadata(['com.example.Service'])).toBeUndefined();
  });
});
