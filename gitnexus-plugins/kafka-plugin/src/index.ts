import {
  ParserPlugin,
  AnalyzerPlugin,
  ParseResult,
  AnalysisResultItem,
  ParserRegistry,
  AnalyzerRegistry,
  AnalysisContext,
  createNode,
  createEdge,
  GraphNode,
  GraphRelationship,
} from 'gitnexus-shared';

/**
 * Kafka 插件
 * 解析 Kafka 相关的代码和配置
 */
export class KafkaPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-kafka-plugin';
  version = '1.0.0';
  description = 'Kafka plugin for GitNexus';
  extensions = ['.yml', '.yaml', '.properties', '.java'];
  languages = ['java'];

  /**
   * 解析文件内容
   */
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];

    try {
      if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
        await this.parseYamlConfig(content, filePath, nodes, edges);
      } else if (filePath.endsWith('.properties')) {
        await this.parsePropertiesConfig(content, filePath, nodes, edges);
      } else if (filePath.endsWith('.java')) {
        // Java 文件由分析器处理
      }

      return {
        nodes,
        edges,
        metadata: {
          format: this.getFileFormat(filePath),
          filePath,
        },
      };
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        metadata: {},
        error: (error as Error).message,
      };
    }
  }

  /**
   * 分析代码语义
   */
  async analyze(
    node: any,
    context: AnalysisContext,
  ): Promise<{ results: AnalysisResultItem[]; metadata: Record<string, any> }> {
    const results: AnalysisResultItem[] = [];

    // 分析 Kafka 消费者
    if (node.type === 'class_declaration') {
      const className = node.name?.text;
      const impls = node['implements'] || [];

      // 检查是否实现了 Kafka 消费者接口
      if (this.isKafkaConsumer(impls)) {
        results.push({
          type: 'kafka.consumer',
          name: className,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
          },
          properties: this.extractConsumerProperties(node),
        });
      }
    }

    // 分析 Kafka 注解
    if (node.type === 'annotation') {
      const annotationName = node.name?.text;
      if (this.isKafkaAnnotation(annotationName)) {
        results.push({
          type: 'kafka.annotation',
          name: annotationName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
          },
          properties: this.extractAnnotationProperties(node),
        });
      }
    }

    // 分析 Kafka 生产者
    if (node.type === 'method_declaration') {
      const methodName = node.name?.text;
      const body = node.body?.text || '';

      // 检查是否包含 Kafka 生产者代码
      if (this.containsKafkaProducerCode(body)) {
        results.push({
          type: 'kafka.producer',
          name: methodName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
          },
          properties: this.extractProducerProperties(node),
        });
      }
    }

    return {
      results,
      metadata: {
        analyzer: this.name,
        language: context.language,
      },
    };
  }

  /**
   * 解析 YAML 配置文件
   */
  private async parseYamlConfig(
    content: string,
    filePath: string,
    nodes: GraphNode[],
    edges: GraphRelationship[],
  ): Promise<void> {
    // 简单的 YAML 解析
    // 实际项目中可以使用 yaml 库进行更复杂的解析

    // 提取 Kafka 配置
    if (content.includes('spring.kafka')) {
      const kafkaNode = createNode('KafkaConfig', {
        name: 'kafka',
        filePath,
      });
      nodes.push(kafkaNode);

      // 提取主题配置
      if (content.includes('topics')) {
        const topicsNode = createNode('KafkaTopics', {
          name: 'topics',
          filePath,
        });
        nodes.push(topicsNode);

        edges.push(
          createEdge('HAS_CONFIG', kafkaNode.id, topicsNode.id, {
            confidence: 1.0,
            reason: 'Kafka topics config',
          }),
        );
      }
    }
  }

  /**
   * 解析 properties 配置文件
   */
  private async parsePropertiesConfig(
    content: string,
    filePath: string,
    nodes: GraphNode[],
    edges: GraphRelationship[],
  ): Promise<void> {
    const lines = content.split('\n');
    const kafkaConfig: Record<string, string> = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const equalsIndex = trimmed.indexOf('=');
      if (equalsIndex > 0) {
        const key = trimmed.substring(0, equalsIndex).trim();
        const value = trimmed.substring(equalsIndex + 1).trim();

        if (key.startsWith('spring.kafka')) {
          kafkaConfig[key] = value;
        }
      }
    }

    // 创建 Kafka 配置节点
    if (Object.keys(kafkaConfig).length > 0) {
      const kafkaNode = createNode('KafkaConfig', {
        name: 'kafka',
        filePath,
      });
      nodes.push(kafkaNode);
    }
  }

  /**
   * 检查是否为 Kafka 消费者
   */
  private isKafkaConsumer(impls: any[]): boolean {
    for (const impl of impls) {
      const implName = impl.text;
      if (
        implName.includes('Consumer') &&
        (implName.includes('Kafka') || implName.includes('Message'))
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查是否为 Kafka 注解
   */
  private isKafkaAnnotation(annotationName: string): boolean {
    const kafkaAnnotations = [
      'KafkaListener',
      'KafkaHandler',
      'TopicPartition',
      'PartitionOffset',
      'Header',
      'SendTo',
    ];
    return kafkaAnnotations.includes(annotationName);
  }

  /**
   * 检查是否包含 Kafka 生产者代码
   */
  private containsKafkaProducerCode(body: string): boolean {
    const producerKeywords = ['KafkaTemplate', 'producer', 'send(', 'kafkaTemplate'];
    return producerKeywords.some((keyword) => body.includes(keyword));
  }

  /**
   * 提取消费者属性
   */
  private extractConsumerProperties(node: any): Record<string, any> {
    const properties: Record<string, any> = {};

    if (node['implements']) {
      properties['implements'] = node['implements'].map((i: any) => i.text);
    }

    if (node.extends) {
      properties.extends = node.extends.text;
    }

    return properties;
  }

  /**
   * 提取注解属性
   */
  private extractAnnotationProperties(annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};

    if (annotation.arguments) {
      properties.arguments = this.extractArguments(annotation.arguments);
    }

    return properties;
  }

  /**
   * 提取生产者属性
   */
  private extractProducerProperties(node: any): Record<string, any> {
    const properties: Record<string, any> = {};

    if (node.returnType) {
      properties.returnType = node.returnType.text;
    }

    if (node.parameters) {
      properties.parameters = node.parameters.map((p: any) => ({
        name: p.name?.text,
        type: p.type?.text,
      }));
    }

    return properties;
  }

  /**
   * 提取参数
   */
  private extractArguments(argumentsNode: any): Record<string, any> {
    const args: Record<string, any> = {};

    if (argumentsNode.type === 'annotation_argument_list') {
      for (const arg of argumentsNode.arguments) {
        if (arg.type === 'assignment_expression') {
          const name = arg.left.text;
          const value = this.extractArgumentValue(arg.right);
          args[name] = value;
        } else {
          args.value = this.extractArgumentValue(arg);
        }
      }
    }

    return args;
  }

  /**
   * 提取参数值
   */
  private extractArgumentValue(valueNode: any): any {
    if (valueNode.type === 'string_literal') {
      return valueNode.value;
    } else if (valueNode.type === 'number_literal') {
      return Number(valueNode.value);
    } else if (valueNode.type === 'boolean_literal') {
      return valueNode.value === 'true';
    } else if (valueNode.type === 'array_expression') {
      return valueNode.elements.map((e: any) => this.extractArgumentValue(e));
    } else if (valueNode.type === 'object_expression') {
      const obj: Record<string, any> = {};
      for (const prop of valueNode.properties) {
        const name = prop.key.text;
        const value = this.extractArgumentValue(prop.value);
        obj[name] = value;
      }
      return obj;
    } else {
      return valueNode.text || valueNode.value;
    }
  }

  /**
   * 获取文件格式
   */
  private getFileFormat(filePath: string): string {
    if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
      return 'yaml';
    } else if (filePath.endsWith('.properties')) {
      return 'properties';
    } else if (filePath.endsWith('.java')) {
      return 'java';
    }
    return 'unknown';
  }

  /**
   * 注册到解析器注册表
   */
  register(registry: ParserRegistry | AnalyzerRegistry): void {
    if ('registerParser' in registry) {
      registry.registerParser(this);
    } else if ('registerAnalyzer' in registry) {
      registry.registerAnalyzer(this);
    }
  }

  /**
   * 检查文件是否支持
   */
  supports(filePath: string): boolean {
    return this.extensions.some((ext) => filePath.endsWith(ext));
  }

  /**
   * 检查语言是否支持
   */
  supportsLanguage(language: string): boolean {
    return this.languages.includes(language);
  }

  /**
   * 初始化插件
   */
  async init(config: any): Promise<void> {
    console.log(`Initialized ${this.name} with config:`, config);
  }

  /**
   * 清理资源
   */
  async dispose(): Promise<void> {
    console.log(`Disposed ${this.name}`);
  }
}

// 导出插件实例
export default new KafkaPlugin();
