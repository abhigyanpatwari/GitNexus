import {
  ParserPlugin,
  AnalyzerPlugin,
  ParseResult,
  AnalysisResultItem,
  ParserRegistry,
  AnalyzerRegistry,
  AnalysisContext,
  GraphNode,
  GraphRelationship,
} from 'gitnexus-shared';

export class JPAPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-jpa-plugin';
  version = '1.0.0';
  description = 'JPA plugin for GitNexus';
  extensions = ['.java'];
  languages = ['java'];

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];
    return { nodes, edges, metadata: { format: 'java', filePath } };
  }

  async analyze(
    node: any,
    context: AnalysisContext,
  ): Promise<{ results: AnalysisResultItem[]; metadata: Record<string, any> }> {
    const results: AnalysisResultItem[] = [];
    if (node.type === 'class_declaration') {
      const className = node.name?.text;
      const annotations = node.annotations || [];
      if (this.isJpaEntity(annotations)) {
        results.push({
          type: 'jpa.entity',
          name: className,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
          },
          properties: this.extractEntityProperties(node, annotations),
        });
      }
    }
    if (node.type === 'interface_declaration') {
      const interfaceName = node.name?.text;
      if (this.isJpaRepository(node)) {
        results.push({
          type: 'jpa.repository',
          name: interfaceName,
          location: {
            filePath: context.filePath,
            startLine: node.startLine,
            endLine: node.endLine,
          },
          properties: this.extractRepositoryProperties(node),
        });
      }
    }
    if (node.type === 'field_declaration') {
      const fieldName = node.declarators?.[0]?.name?.text;
      const annotations = node.annotations || [];
      for (const annotation of annotations) {
        const annotationName = annotation.name?.text;
        if (this.isJpaFieldAnnotation(annotationName)) {
          results.push({
            type: 'jpa.field',
            name: fieldName,
            annotation: annotationName,
            location: {
              filePath: context.filePath,
              startLine: node.startLine,
              endLine: node.endLine,
            },
            properties: this.extractFieldProperties(node, annotation),
          });
        }
      }
    }
    return { results, metadata: { analyzer: this.name, language: context.language } };
  }

  private isJpaEntity(annotations: any[]): boolean {
    return annotations.some((a) =>
      ['Entity', 'Embeddable', 'MappedSuperclass'].includes(a.name?.text),
    );
  }

  private isJpaRepository(node: any): boolean {
    if (!node.extends) return false;
    const extendsName = node.extends.text;
    return extendsName.includes('Repository') || extendsName.includes('JpaRepository');
  }

  private isJpaFieldAnnotation(name: string): boolean {
    return [
      'Id',
      'GeneratedValue',
      'Column',
      'JoinColumn',
      'OneToOne',
      'OneToMany',
      'ManyToOne',
      'ManyToMany',
      'Embedded',
      'EmbeddedId',
      'Transient',
      'Temporal',
      'Lob',
    ].includes(name);
  }

  private extractEntityProperties(node: any, annotations: any[]): Record<string, any> {
    const props: Record<string, any> = {};
    for (const a of annotations) {
      if (a.name?.text === 'Table') props.table = this.extractArguments(a.arguments);
      if (a.name?.text === 'Entity') props.entity = this.extractArguments(a.arguments);
    }
    if (node.extends) props.extends = node.extends.text;
    if (node['implements']) props['implements'] = node['implements'].map((i: any) => i.text);
    return props;
  }

  private extractRepositoryProperties(node: any): Record<string, any> {
    const props: Record<string, any> = {};
    if (node.extends) props.extends = node.extends.text;
    if (node['implements']) props['implements'] = node['implements'].map((i: any) => i.text);
    if (node.typeParameters) props.typeParameters = node.typeParameters.map((t: any) => t.text);
    if (node.body?.methods)
      props.queryMethods = node.body.methods.map((m: any) => ({
        name: m.name?.text,
        returnType: m.returnType?.text,
      }));
    return props;
  }

  private extractFieldProperties(node: any, annotation: any): Record<string, any> {
    const props: Record<string, any> = {};
    if (annotation.arguments)
      props.annotationArguments = this.extractArguments(annotation.arguments);
    if (node.type) props.type = node.type.text;
    return props;
  }

  private extractArguments(args: any): Record<string, any> {
    const result: Record<string, any> = {};
    if (args?.type === 'annotation_argument_list') {
      for (const arg of args.arguments || []) {
        if (arg.type === 'assignment_expression') {
          result[arg.left.text] = this.extractArgumentValue(arg.right);
        }
      }
    }
    return result;
  }

  private extractArgumentValue(node: any): any {
    if (!node) return undefined;
    if (node.type === 'string_literal') return node.value;
    if (node.type === 'number_literal') return Number(node.value);
    if (node.type === 'boolean_literal') return node.value === 'true';
    return node.text || node.value;
  }

  register(registry: ParserRegistry | AnalyzerRegistry): void {
    if ('registerParser' in registry) registry.registerParser(this);
    else if ('registerAnalyzer' in registry) registry.registerAnalyzer(this);
  }

  supports(filePath: string): boolean {
    return this.extensions.some((e) => filePath.endsWith(e));
  }
  supportsLanguage(language: string): boolean {
    return this.languages.includes(language);
  }
  async init(config: any): Promise<void> {
    console.log(`Initialized ${this.name}`);
  }
  async dispose(): Promise<void> {
    console.log(`Disposed ${this.name}`);
  }
}

export default new JPAPlugin();
