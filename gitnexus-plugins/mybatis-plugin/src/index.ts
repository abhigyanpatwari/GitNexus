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
 * MyBatis 插件
 * 解析 MyBatis 框架的 Mapper 接口和 XML 映射文件
 */
export class MyBatisPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-mybatis-plugin';
  version = '1.0.0';
  description = 'MyBatis plugin for GitNexus';
  extensions = ['.xml', '.java'];
  languages = ['java'];

  /**
   * 解析文件内容
   */
  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];

    try {
      if (filePath.endsWith('.xml')) {
        await this.parseXmlMapper(content, filePath, nodes, edges);
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

    // 分析 MyBatis Mapper 接口
    if (node.type === 'interface_declaration') {
      const interfaceName = node.name?.text;
      const annotations = node.annotations || [];

      // 检查是否为 MyBatis Mapper 接口
      if (this.isMapperInterface(annotations)) {
        results.push({
          type: 'mybatis.mapper',
          name: interfaceName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
          },
          properties: this.extractMapperProperties(node),
        });
      }
    }

    // 分析方法上的 MyBatis 注解
    if (node.type === 'method_declaration') {
      const methodName = node.name?.text;
      const annotations = node.annotations || [];

      for (const annotation of annotations) {
        const annotationName = annotation.name?.text;
        if (this.isMyBatisAnnotation(annotationName)) {
          results.push({
            type: 'mybatis.method',
            name: methodName,
            annotation: annotationName,
            location: {
              filePath: context.filePath,
              startLine: node.startLine,
              endLine: node.endLine,
            },
            properties: this.extractMethodProperties(node, annotation),
          });
        }
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
   * 解析 XML Mapper 文件
   */
  private async parseXmlMapper(
    content: string,
    filePath: string,
    nodes: GraphNode[],
    edges: GraphRelationship[],
  ): Promise<void> {
    // 简单的 XML 解析
    // 实际项目中可以使用 xml2js 等库进行更复杂的解析

    // 提取命名空间
    const namespaceMatch = content.match(/namespace="([^"]+)"/);
    if (namespaceMatch) {
      const namespace = namespaceMatch[1];

      const mapperNode = createNode('MyBatisXmlMapper', {
        name: namespace,
        filePath,
        type: 'xml',
      });
      nodes.push(mapperNode);

      // 提取 SQL 语句
      const sqlStatements = this.extractSqlStatements(content);

      for (const sql of sqlStatements) {
        const sqlNode = createNode('MyBatisSql', {
          name: sql.id,
          type: sql.type,
          filePath,
        });
        nodes.push(sqlNode);

        edges.push(
          createEdge('HAS_SQL', mapperNode.id, sqlNode.id, {
            confidence: 1.0,
            reason: 'MyBatis SQL statement',
          }),
        );
      }
    }
  }

  /**
   * 提取 SQL 语句
   */
  private extractSqlStatements(content: string): Array<{ id: string; type: string }> {
    const statements = [];
    const statementTypes = [
      'select',
      'insert',
      'update',
      'delete',
      'resultMap',
      'parameterMap',
      'sql',
    ];

    for (const type of statementTypes) {
      const regex = new RegExp(`<${type}\\s+id="([^"]+)"`, 'g');
      let match;
      while ((match = regex.exec(content)) !== null) {
        statements.push({
          id: match[1],
          type,
        });
      }
    }

    return statements;
  }

  /**
   * 检查是否为 Mapper 接口
   */
  private isMapperInterface(annotations: any[]): boolean {
    for (const annotation of annotations) {
      const annotationName = annotation.name?.text;
      if (annotationName === 'Mapper' || annotationName === 'Repository') {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查是否为 MyBatis 注解
   */
  private isMyBatisAnnotation(annotationName: string): boolean {
    const myBatisAnnotations = [
      'Select',
      'Insert',
      'Update',
      'Delete',
      'ResultMap',
      'Param',
      'Options',
      'Result',
      'Results',
    ];
    return myBatisAnnotations.includes(annotationName);
  }

  /**
   * 提取 Mapper 接口属性
   */
  private extractMapperProperties(node: any): Record<string, any> {
    const properties: Record<string, any> = {};

    if (node.extends) {
      properties.extends = node.extends.text;
    }

    if (node['implements']) {
      properties['implements'] = node['implements'].map((i: any) => i.text);
    }

    if (node.typeParameters) {
      properties.typeParameters = node.typeParameters.map((t: any) => t.text);
    }

    // 提取方法
    if (node.body && node.body.methods) {
      properties.methods = node.body.methods.map((m: any) => m.name?.text);
    }

    return properties;
  }

  /**
   * 提取方法属性
   */
  private extractMethodProperties(node: any, annotation: any): Record<string, any> {
    const properties: Record<string, any> = {};

    if (annotation.arguments) {
      properties.annotationArguments = this.extractArguments(annotation.arguments);
    }

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
    if (filePath.endsWith('.xml')) {
      return 'xml';
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
export default new MyBatisPlugin();
