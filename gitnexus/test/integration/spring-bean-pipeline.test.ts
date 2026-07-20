import { beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-bean-app');

describe('Spring Bean candidate inventory pipeline', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
  }, 60_000);

  it('attaches canonical framework annotations after Java import resolution', () => {
    const classes = new Map<string, Record<string, unknown>>();
    result.graph.forEachNode((node) => {
      if (node.label === 'Class') classes.set(String(node.properties.name), node.properties);
    });

    expect(classes.get('WidgetComponent')).toMatchObject({
      frameworkAnnotations: ['org.springframework.stereotype.Component'],
    });
    expect(classes.get('BillingService')).toMatchObject({
      frameworkAnnotations: ['org.springframework.stereotype.Service'],
    });
    expect(classes.get('WidgetRepository')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Repository',
    ]);
    expect(classes.get('PageController')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Controller',
    ]);
    expect(classes.get('ApiController')?.frameworkAnnotations).toEqual([
      'org.springframework.web.bind.annotation.RestController',
    ]);
    expect(classes.get('AppConfiguration')?.frameworkAnnotations).toEqual([
      'org.springframework.context.annotation.Configuration',
    ]);
    expect(classes.get('NestedService')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Service',
    ]);
    expect(classes.get('ExplicitAlongsideWildcard')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Service',
    ]);
    expect(classes.get('WildcardService')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Service',
    ]);

    for (const name of [
      'PlainUtility',
      'WildcardCandidate',
      'MultipleWildcardService',
      'MemberShadowedService',
      'ConflictingBean',
      'ComposedService',
      'ExplicitCustomService',
      'TopLevelShadowedComponent',
      'InheritedMemberShadowedService',
      'StaticImportShadowedService',
    ]) {
      expect(classes.get(name)).not.toHaveProperty('frameworkAnnotations');
    }
  });

  it('uses the same candidate rules for Kotlin classes', () => {
    const symbols = new Map<string, Record<string, unknown>>();
    result.graph.forEachNode((node) => {
      symbols.set(String(node.properties.name), node.properties);
    });

    expect(symbols.get('KotlinWidgetComponent')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Component',
    ]);
    expect(symbols.get('KotlinBillingService')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Service',
    ]);
    expect(symbols.get('KotlinConfiguration')?.frameworkAnnotations).toEqual([
      'org.springframework.context.annotation.Configuration',
    ]);
    expect(symbols.get('KotlinAbstractService')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Service',
    ]);
    expect(symbols.get('KotlinApiController')?.frameworkAnnotations).toEqual([
      'org.springframework.web.bind.annotation.RestController',
    ]);
    expect(symbols.get('KotlinServiceId')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Service',
    ]);
    expect(symbols.get('KotlinNestedService')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Service',
    ]);
    expect(symbols.get('KotlinWildcardRepository')?.frameworkAnnotations).toEqual([
      'org.springframework.stereotype.Repository',
    ]);

    for (const name of [
      'KotlinServiceContract',
      'KotlinServiceObject',
      'KotlinServiceState',
      'KotlinServiceMarker',
      'KotlinComposedCandidate',
      'KotlinMemberShadowedService',
      'KotlinShadowedService',
      'KotlinMultipleWildcardService',
    ]) {
      expect(symbols.get(name)).not.toHaveProperty('frameworkAnnotations');
    }
  });

  it('keeps RestController route discovery and HANDLES_ROUTE emission intact', () => {
    let pingRouteId: string | undefined;
    result.graph.forEachNode((node) => {
      if (node.label === 'Route' && node.properties.name === '/ping') pingRouteId = node.id;
    });

    expect(pingRouteId).toBeDefined();
    let handlesRoute = false;
    result.graph.forEachRelationship((rel) => {
      if (rel.type === 'HANDLES_ROUTE' && rel.targetId === pingRouteId) handlesRoute = true;
    });
    expect(handlesRoute).toBe(true);
  });
});
