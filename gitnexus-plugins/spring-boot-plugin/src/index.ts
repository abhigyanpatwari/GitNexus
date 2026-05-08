import {
  ParserPlugin,
  AnalyzerPlugin,
  ParseResult,
  AnalysisResult,
  AnalysisResultItem,
  ParserRegistry,
  AnalyzerRegistry,
  AnalysisContext,
} from 'gitnexus-shared';
import { parse } from 'yaml';
import type {
  NodeLabel,
  RelationshipType,
  GraphNode,
  GraphRelationship,
  NodeProperties,
} from 'gitnexus-shared';

function generateId(type: NodeLabel, key: string): string {
  return `${type.toLowerCase()}:${key}`;
}

function createSpringNode(
  label: NodeLabel,
  name: string,
  filePath: string,
  properties: Record<string, unknown> = {},
): GraphNode {
  const id = generateId(label, `${filePath}:${name}`);
  return {
    id,
    label,
    properties: {
      name,
      filePath,
      ...properties,
    } as NodeProperties,
  };
}

function createSpringEdge(
  type: RelationshipType,
  sourceId: string,
  targetId: string,
  properties?: Record<string, unknown>,
): GraphRelationship {
  return {
    id: `${sourceId}-${type}-${targetId}`,
    sourceId,
    targetId,
    type,
    confidence: 1.0,
    reason: `Spring Boot ${type} relationship`,
    properties: properties as GraphRelationship['properties'],
  };
}

interface SpringComponent {
  name: string;
  beanType:
    | 'component'
    | 'service'
    | 'repository'
    | 'controller'
    | 'restController'
    | 'configuration'
    | 'beanMethod'
    | 'aspect';
  beanName?: string;
  scope?: string;
  isPrimary?: boolean;
  isLazy?: boolean;
  qualifier?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  injections?: SpringInjection[];
  aspectExpressions?: string[];
  advices?: SpringAdvice[];
}

interface SpringInjection {
  type: 'constructor' | 'field' | 'setter' | 'method';
  targetField?: string;
  sourceClass: string;
  qualifier?: string;
  isRequired?: boolean;
}

interface SpringAdvice {
  type: 'before' | 'after' | 'around' | 'afterReturning' | 'afterThrowing';
  methodName: string;
  pointcut: string;
  startLine?: number;
  endLine?: number;
}

interface SpringAnnotation {
  name: string;
  arguments?: Record<string, unknown>;
}

interface AnnotationMetadata {
  resultType: string;
  properties?: string[];
  extractProperties?: (args: Record<string, unknown>) => Record<string, unknown>;
  createsRelation?: {
    type: RelationshipType;
    targetType?: 'bean' | 'config' | 'event' | 'cache';
    targetResolver?: (args: Record<string, unknown>) => string | null;
  };
}

const SPRING_ANNOTATIONS: Record<string, AnnotationMetadata> = {
  Transactional: {
    resultType: 'spring.boot.transactional',
    properties: [
      'propagation',
      'isolation',
      'timeout',
      'readOnly',
      'rollbackFor',
      'noRollbackFor',
      'value',
    ],
    createsRelation: { type: 'TRANSACTIONS', targetType: 'bean' },
  },
  Cacheable: {
    resultType: 'spring.boot.cache',
    properties: ['cacheNames', 'key', 'condition', 'unless', 'value'],
    createsRelation: { type: 'MANAGES', targetType: 'cache' },
  },
  CachePut: {
    resultType: 'spring.boot.cache',
    properties: ['cacheNames', 'key', 'condition', 'unless', 'value'],
  },
  CacheEvict: {
    resultType: 'spring.boot.cache',
    properties: ['cacheNames', 'key', 'condition', 'allEntries', 'beforeInvocation', 'value'],
  },
  Scheduled: {
    resultType: 'spring.boot.scheduled',
    properties: [
      'cron',
      'fixedDelay',
      'fixedDelayString',
      'fixedRate',
      'fixedRateString',
      'initialDelay',
      'initialDelayString',
      'value',
    ],
  },
  Async: {
    resultType: 'spring.boot.async',
    properties: ['value'],
  },
  PreAuthorize: {
    resultType: 'spring.boot.security',
    properties: ['value', 'spelRef'],
    createsRelation: { type: 'SECURES' },
  },
  PostAuthorize: {
    resultType: 'spring.boot.security',
    properties: ['value', 'spelRef'],
    createsRelation: { type: 'SECURES' },
  },
  Secured: {
    resultType: 'spring.boot.security',
    properties: ['value', 'rolesAllowed'],
    createsRelation: { type: 'SECURES' },
  },
  EventListener: {
    resultType: 'spring.boot.event',
    properties: ['value', 'condition', 'classes'],
  },
  Before: {
    resultType: 'spring.boot.advice',
    properties: ['pointcut', 'argNames', 'value'],
  },
  After: {
    resultType: 'spring.boot.advice',
    properties: ['pointcut', 'argNames', 'value'],
  },
  Around: {
    resultType: 'spring.boot.advice',
    properties: ['pointcut', 'argNames', 'value'],
  },
  AfterReturning: {
    resultType: 'spring.boot.advice',
    properties: ['pointcut', 'argNames', 'returning', 'value'],
  },
  AfterThrowing: {
    resultType: 'spring.boot.advice',
    properties: ['pointcut', 'argNames', 'throwing', 'value'],
  },
  Pointcut: {
    resultType: 'spring.boot.pointcut',
    properties: ['value', 'argNames'],
  },
};

interface AnnotationContext {
  targetName: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

export class SpringBootPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-spring-boot-plugin';
  version = '3.0.0';
  description =
    'Spring Boot plugin for GitNexus with Bean and DI support (Annotation Registry Pattern)';
  extensions = ['.yml', '.yaml', '.properties', '.java'];
  languages = ['java'];

  private components: Map<string, SpringComponent> = new Map();
  private pendingRelations: Array<{
    sourceId: string;
    targetId: string;
    relation: GraphRelationship;
  }> = [];

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];

    try {
      if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
        await this.parseYamlConfig(content, filePath, nodes, edges);
      } else if (filePath.endsWith('.properties')) {
        await this.parsePropertiesConfig(content, filePath, nodes, edges);
      }
      return { nodes, edges, metadata: { format: this.getFileFormat(filePath), filePath } };
    } catch (error) {
      return { nodes: [], edges: [], metadata: {}, error: (error as Error).message };
    }
  }

  async analyze(node: any, context: AnalysisContext): Promise<AnalysisResult> {
    const results: AnalysisResult['results'] = [];

    if (node.type === 'class_declaration' || node.type === 'interface_declaration') {
      const classNode = node;
      const annotations = this.extractAnnotations(classNode);
      const springAnnotation = this.detectSpringComponent(annotations);

      if (springAnnotation) {
        const component = this.extractComponent(classNode, springAnnotation, context.filePath);
        this.components.set(component.name, component);

        results.push({
          type: 'spring.boot.component',
          name: component.name,
          componentType: component.beanType,
          location: {
            filePath: context.filePath,
            startLine: component.startLine,
            endLine: component.endLine,
          },
          properties: {
            beanName: component.beanName,
            beanType: component.beanType,
            beanScope: component.scope,
            isPrimary: component.isPrimary,
            isLazy: component.isLazy,
            qualifier: component.qualifier,
            aspectExpressions: component.aspectExpressions,
            advices: component.advices,
          },
        });
      }

      const injections = this.extractInjections(classNode, annotations);
      for (const injection of injections) {
        results.push({
          ...injection,
          type: 'spring.boot.injection',
          location: {
            filePath: context.filePath,
            startLine: classNode.startLine,
            endLine: classNode.endLine,
          },
        });
      }
    }

    if (node.type === 'method_definition') {
      const methodNode = node;
      const annotations = this.extractAnnotations(methodNode);
      const methodName = methodNode.name?.text || '';

      for (const ann of annotations) {
        const result = this.processSpringAnnotation(ann, {
          targetName: methodName,
          filePath: context.filePath,
          startLine: methodNode.startLine,
          endLine: methodNode.endLine,
        });

        if (result) {
          results.push(result);
        }
      }
    }

    return {
      results,
      metadata: { analyzer: this.name, language: context.language },
    };
  }

  private processSpringAnnotation(
    ann: SpringAnnotation,
    ctx: AnnotationContext,
  ): AnalysisResultItem | null {
    const meta = SPRING_ANNOTATIONS[ann.name];
    if (!meta) return null;

    const args = ann.arguments || {};
    let properties: Record<string, unknown>;

    if (meta.extractProperties) {
      properties = meta.extractProperties(args);
    } else if (meta.properties) {
      properties = {};
      for (const prop of meta.properties) {
        if (args[prop] !== undefined) {
          properties[prop] = args[prop];
        }
      }
    } else {
      properties = args;
    }

    const result: AnalysisResultItem = {
      type: meta.resultType,
      name: ctx.targetName,
      properties,
      location: {
        filePath: ctx.filePath,
        startLine: ctx.startLine,
        endLine: ctx.endLine,
      },
    };

    return result;
  }

  async onEnd?(context: { nodes: GraphNode[]; edges: GraphRelationship[] }): Promise<void> {
    const beans: GraphNode[] = [];
    const diEdges: GraphRelationship[] = [];
    const aopEdges: GraphRelationship[] = [];

    for (const [name, component] of this.components) {
      const beanNode = createSpringNode('Bean', component.beanName || name, component.filePath, {
        beanName: component.beanName,
        beanType: component.beanType,
        beanScope: component.scope,
        isPrimary: component.isPrimary,
        isLazy: component.isLazy,
        qualifier: component.qualifier,
        startLine: component.startLine,
        endLine: component.endLine,
        aspectExpressions: component.aspectExpressions,
        advices: component.advices,
      });
      beans.push(beanNode);

      if (component.injections) {
        for (const injection of component.injections) {
          const targetComponent = this.components.get(injection.sourceClass);
          if (targetComponent) {
            const targetBeanId = generateId(
              'Bean',
              `${targetComponent.filePath}:${targetComponent.beanName || targetComponent.name}`,
            );
            const sourceBeanId = generateId(
              'Bean',
              `${component.filePath}:${component.beanName || component.name}`,
            );

            diEdges.push(
              createSpringEdge('INJECTS_INTO', targetBeanId, sourceBeanId, {
                injectionType: injection.type,
                qualifier: injection.qualifier,
                isRequired: injection.isRequired,
              }),
            );
          }
        }
      }

      if (component.beanType === 'aspect' && component.advices) {
        for (const advice of component.advices) {
          const aspectBeanId = generateId(
            'Bean',
            `${component.filePath}:${component.beanName || component.name}`,
          );
          const targetClass = this.parsePointcutTarget(advice.pointcut);
          if (targetClass) {
            const targetComponent = this.components.get(targetClass);
            if (targetComponent) {
              const targetBeanId = generateId(
                'Bean',
                `${targetComponent.filePath}:${targetComponent.beanName || targetComponent.name}`,
              );
              aopEdges.push(
                createSpringEdge('ADVISES', aspectBeanId, targetBeanId, {
                  adviceType: advice.type,
                  methodName: advice.methodName,
                  pointcut: advice.pointcut,
                }),
              );
            }
          }
        }
      }
    }

    context.nodes.push(...beans);
    context.edges.push(...diEdges);
    context.edges.push(...aopEdges);
  }

  private async parseYamlConfig(
    content: string,
    filePath: string,
    nodes: GraphNode[],
    edges: GraphRelationship[],
  ): Promise<void> {
    const data = parse(content);

    if (data.spring?.datasource) {
      const dsNode = createSpringNode('ConfigProperty', 'spring.datasource', filePath, {
        configKey: 'spring.datasource',
        configType: 'yaml',
        defaultValue: JSON.stringify(data.spring.datasource),
      });
      nodes.push(dsNode);
    }

    if (data.spring?.jpa) {
      const jpaNode = createSpringNode('ConfigProperty', 'spring.jpa', filePath, {
        configKey: 'spring.jpa',
        configType: 'yaml',
        defaultValue: JSON.stringify(data.spring.jpa),
      });
      nodes.push(jpaNode);
    }

    if (data.spring?.kafka) {
      const kafkaBootstrapServers = data.spring.kafka.bootstrapServers;
      if (kafkaBootstrapServers) {
        const kafkaNode = createSpringNode(
          'ConfigProperty',
          'spring.kafka.bootstrap-servers',
          filePath,
          {
            configKey: 'spring.kafka.bootstrap-servers',
            configType: 'yaml',
            kafkaBootstrapServers,
            defaultValue: kafkaBootstrapServers,
          },
        );
        nodes.push(kafkaNode);

        if (data.spring.kafka.consumer?.groupId) {
          const consumerNode = createSpringNode(
            'KafkaConsumer',
            `consumer-${data.spring.kafka.consumer.groupId}`,
            filePath,
            {
              kafkaGroupId: data.spring.kafka.consumer.groupId,
              kafkaBootstrapServers,
            },
          );
          nodes.push(consumerNode);
          edges.push(createSpringEdge('CONSUMES_FROM', consumerNode.id, kafkaNode.id));
        }

        if (data.spring.kafka.producer?.groupId) {
          const producerNode = createSpringNode(
            'KafkaProducer',
            `producer-${data.spring.kafka.producer.groupId}`,
            filePath,
            {
              kafkaBootstrapServers,
            },
          );
          nodes.push(producerNode);
          edges.push(createSpringEdge('PRODUCES_TO', producerNode.id, kafkaNode.id));
        }
      }
    }
  }

  private async parsePropertiesConfig(
    content: string,
    filePath: string,
    nodes: GraphNode[],
    edges: GraphRelationship[],
  ): Promise<void> {
    const lines = content.split('\n');
    const configMap: Record<string, string> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex > 0) {
        const key = trimmed.substring(0, equalsIndex).trim();
        const value = trimmed.substring(equalsIndex + 1).trim();
        configMap[key] = value;
      }
    }

    if (configMap['spring.datasource.url']) {
      const dsNode = createSpringNode('ConfigProperty', 'spring.datasource', filePath, {
        configKey: 'spring.datasource',
        configType: 'properties',
        defaultValue: JSON.stringify(configMap),
      });
      nodes.push(dsNode);
    }

    if (configMap['spring.kafka.bootstrap-servers']) {
      const kafkaNode = createSpringNode(
        'ConfigProperty',
        'spring.kafka.bootstrap-servers',
        filePath,
        {
          configKey: 'spring.kafka.bootstrap-servers',
          configType: 'properties',
          kafkaBootstrapServers: configMap['spring.kafka.bootstrap-servers'],
          defaultValue: configMap['spring.kafka.bootstrap-servers'],
        },
      );
      nodes.push(kafkaNode);
    }
  }

  private extractAnnotations(node: any): SpringAnnotation[] {
    const annotations: SpringAnnotation[] = [];
    const modifiers = node.modifiers;

    if (modifiers) {
      for (const modifier of modifiers) {
        if (modifier.type === 'annotation' || modifier.type === 'marker_annotation') {
          const nameNode = modifier.childForFieldName?.('name') || modifier.firstNamedChild;
          if (nameNode) {
            annotations.push({
              name: nameNode.text?.replace(/^@/, '') || '',
              arguments: this.extractAnnotationArguments(modifier),
            });
          }
        }
      }
    }
    return annotations;
  }

  private extractAnnotationArguments(annotation: any): Record<string, unknown> | undefined {
    const elementValues = annotation.elementValues || annotation.element_value_pairs;
    if (!elementValues || elementValues.length === 0) return undefined;

    const args: Record<string, unknown> = {};
    for (const pair of elementValues) {
      const key = pair.key?.text || pair.element?.text || '';
      const value = this.extractAnnotationValue(pair.value);
      args[key] = value;
    }
    return args;
  }

  private extractAnnotationValue(valueNode: any): unknown {
    if (!valueNode) return undefined;

    switch (valueNode.type) {
      case 'string_literal':
        return valueNode.text?.replace(/^["']|["']$/g, '');
      case 'number_literal':
        return Number(valueNode.text);
      case 'boolean_literal':
        return valueNode.text === 'true';
      case 'class_literal':
        return valueNode.text?.replace(/\.class$/, '');
      default:
        return valueNode.text;
    }
  }

  private detectSpringComponent(annotations: SpringAnnotation[]): SpringAnnotation | null {
    const componentAnnotations = [
      { name: 'Component', type: 'component' as const },
      { name: 'Service', type: 'service' as const },
      { name: 'Repository', type: 'repository' as const },
      { name: 'Controller', type: 'controller' as const },
      { name: 'RestController', type: 'restController' as const },
      { name: 'Configuration', type: 'configuration' as const },
      { name: 'Aspect', type: 'aspect' as const },
    ];

    for (const ann of annotations) {
      const found = componentAnnotations.find((c) => c.name === ann.name);
      if (found) return ann;
    }
    return null;
  }

  private extractComponent(
    node: any,
    annotation: SpringAnnotation,
    filePath: string,
  ): SpringComponent {
    const name = node.name?.text || '';
    const args = annotation.arguments || {};

    let beanType: SpringComponent['beanType'] = 'component';
    if (annotation.name === 'Service') beanType = 'service';
    else if (annotation.name === 'Repository') beanType = 'repository';
    else if (annotation.name === 'Controller') beanType = 'controller';
    else if (annotation.name === 'RestController') beanType = 'restController';
    else if (annotation.name === 'Configuration') beanType = 'configuration';
    else if (annotation.name === 'Aspect') beanType = 'aspect';

    const beanName = (args.value as string) || (args['name'] as string) || this.toBeanName(name);

    return {
      name,
      beanType,
      beanName,
      scope: args.scope as string,
      isPrimary: annotation.name === 'Primary' || args.primary === true,
      isLazy: args.lazy === true,
      qualifier: args.qualifier as string,
      filePath,
      startLine: node.startLine,
      endLine: node.endLine,
      aspectExpressions: this.extractAspectExpressions(node),
      advices: this.extractAdvices(node),
    };
  }

  private extractInjections(node: any, annotations: SpringAnnotation[]): SpringInjection[] {
    const injections: SpringInjection[] = [];

    const hasAutowired = annotations.some((a) => a.name === 'Autowired' || a.name === 'Inject');

    if (hasAutowired) {
      injections.push({
        type: 'field',
        sourceClass: this.inferInjectedType(node),
      });
    }

    return injections;
  }

  private inferInjectedType(node: any): string {
    if (node.extends?.text) {
      return node.extends.text;
    }
    if (node.implements) {
      for (const impl of node.implements) {
        if (impl.text?.includes('Service') || impl.text?.includes('Repository')) {
          return impl.text;
        }
      }
    }
    return 'unknown';
  }

  private extractAdvices(node: any): SpringAdvice[] {
    const advices: SpringAdvice[] = [];

    const methods = node.members || node.body?.statements || [];
    for (const method of methods) {
      if (method.type === 'method_definition') {
        const methodAnnotations = this.extractAnnotations(method);

        for (const ann of methodAnnotations) {
          if (this.isAdviceAnnotation(ann.name)) {
            const adviceType = this.getAdviceType(ann.name);
            const pointcut =
              (ann.arguments?.value as string) || (ann.arguments?.['value'] as string) || '';

            if (adviceType) {
              advices.push({
                type: adviceType,
                methodName: method.name?.text || '',
                pointcut,
                startLine: method.startLine,
                endLine: method.endLine,
              });
            }
          }
        }
      }
    }

    return advices;
  }

  private extractAspectExpressions(node: any): string[] {
    const expressions: string[] = [];

    const methods = node.members || node.body?.statements || [];
    for (const method of methods) {
      if (method.type === 'method_definition') {
        const annotations = this.extractAnnotations(method);

        for (const ann of annotations) {
          if (ann.name === 'Pointcut') {
            const expression =
              (ann.arguments?.value as string) || (ann.arguments?.['value'] as string);
            if (expression) {
              expressions.push(expression);
            }
          }
        }
      }
    }

    return expressions;
  }

  private isAdviceAnnotation(name: string): boolean {
    const adviceAnnotations = ['Before', 'After', 'Around', 'AfterReturning', 'AfterThrowing'];
    return adviceAnnotations.includes(name);
  }

  private getAdviceType(annotationName: string): SpringAdvice['type'] | null {
    const typeMap: Record<string, SpringAdvice['type']> = {
      Before: 'before',
      After: 'after',
      Around: 'around',
      AfterReturning: 'afterReturning',
      AfterThrowing: 'afterThrowing',
    };
    return typeMap[annotationName] || null;
  }

  private parsePointcutTarget(pointcut: string): string | null {
    const classMatch = pointcut.match(/\*\s+([^\.]+)\.([^\(]+)\.\*\(\.\.\)/);
    if (classMatch && classMatch[1]) {
      return classMatch[1];
    }
    const fullClassMatch = pointcut.match(/\*\s+([\w\.]+)\.\*\(\.\.\)/);
    if (fullClassMatch && fullClassMatch[1]) {
      const parts = fullClassMatch[1].split('.');
      return parts[parts.length - 1];
    }
    return null;
  }

  private toBeanName(name: string): string {
    if (!name) return name;
    return name.charAt(0).toLowerCase() + name.slice(1);
  }

  private getFileFormat(filePath: string): string {
    if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) return 'yaml';
    if (filePath.endsWith('.properties')) return 'properties';
    if (filePath.endsWith('.java')) return 'java';
    return 'unknown';
  }

  register(registry: ParserRegistry | AnalyzerRegistry): void {
    if ('registerParser' in registry) registry.registerParser(this);
    else if ('registerAnalyzer' in registry) registry.registerAnalyzer(this);
  }

  supports(filePath: string): boolean {
    return this.extensions.some((ext) => filePath.endsWith(ext));
  }

  supportsLanguage(language: string): boolean {
    return this.languages.includes(language);
  }

  async init(config: any): Promise<void> {
    this.components.clear();
    this.pendingRelations = [];
  }

  async dispose(): Promise<void> {
    this.components.clear();
    this.pendingRelations = [];
  }
}

export default new SpringBootPlugin();
