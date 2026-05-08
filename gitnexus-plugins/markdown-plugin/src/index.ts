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

// ========= 接口定义 =========

export interface MarkdownProfile {
  name: string;
  detect: (content: string, filePath: string) => boolean;
  parsers: SectionParser[];
  priority?: number;
}

export interface SectionParser {
  name: string;
  parse: (
    lines: string[],
    startIndex: number,
    filePath: string,
    context: { currentHeadingId?: string },
  ) => {
    nodes: GraphNode[];
    edges: GraphRelationship[];
    nextIndex: number;
  } | null;
}

// ========= 内置解析器 =========

class HeadingParser implements SectionParser {
  name = 'heading';

  parse(lines: string[], startIndex: number, filePath: string, context: any) {
    const line = lines[startIndex];
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (!match) return null;

    const level = match[1].length;
    const text = match[2].trim();
    const id = `${filePath}:heading:${startIndex + 1}`;

    const node = createNode('MarkdownHeading', {
      name: text,
      filePath,
      level,
      startLine: startIndex + 1,
      id,
    });

    const nodes: GraphNode[] = [node];
    const edges: GraphRelationship[] = [];

    // 连接到前一个标题
    if (context.currentHeadingId) {
      edges.push(createEdge('HAS_HEADING', context.currentHeadingId, node.id, {}));
    }

    context.currentHeadingId = node.id;
    return { nodes, edges, nextIndex: startIndex + 1 };
  }
}

class CodeBlockParser implements SectionParser {
  name = 'code-block';

  parse(lines: string[], startIndex: number, filePath: string, context: any) {
    const line = lines[startIndex];
    if (!line.startsWith('```')) return null;

    const lang = line.slice(3).trim();
    const contentLines: string[] = [];
    let j = startIndex + 1;

    while (j < lines.length && !lines[j].startsWith('```')) {
      contentLines.push(lines[j]);
      j++;
    }

    const codeNode = createNode('CodeBlock', {
      name: `code-${startIndex + 1}`,
      filePath,
      language: lang,
      startLine: startIndex + 1,
      endLine: j + 1,
      content: contentLines.join('\n'),
    });

    const nodes: GraphNode[] = [codeNode];
    const edges: GraphRelationship[] = [];

    if (context.currentHeadingId) {
      edges.push(createEdge('HAS_CODE_BLOCK', context.currentHeadingId, codeNode.id, {}));
    }

    return { nodes, edges, nextIndex: j + 1 };
  }
}

class LinkParser implements SectionParser {
  name = 'link';

  parse(lines: string[], startIndex: number, filePath: string, context: any) {
    const line = lines[startIndex];
    const links: { text: string; url: string; type: 'inline' | 'reference' }[] = [];

    // 内联链接 [text](url)
    const inlineRegex = /\[([^\]]*)\]\(([^)]+)\)/g;
    let match;
    while ((match = inlineRegex.exec(line)) !== null) {
      links.push({ text: match[1], url: match[2], type: 'inline' });
    }

    // 引用链接 [text][ref]
    const refRegex = /\[([^\]]*)\]\[([^\]]*)\]/g;
    while ((match = refRegex.exec(line)) !== null) {
      links.push({ text: match[1], url: match[2], type: 'reference' });
    }

    if (links.length === 0) return null;

    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];

    links.forEach((link, index) => {
      const linkNode = createNode('Link', {
        name: link.text || link.url,
        filePath,
        url: link.url,
        linkText: link.text,
        linkType: link.type,
        startLine: startIndex + 1,
      });
      nodes.push(linkNode);

      if (context.currentHeadingId) {
        edges.push(createEdge('LINKS_TO', context.currentHeadingId, linkNode.id, {}));
      }
    });

    return { nodes, edges, nextIndex: startIndex + 1 };
  }
}

class ImageParser implements SectionParser {
  name = 'image';

  parse(lines: string[], startIndex: number, filePath: string, context: any) {
    const line = lines[startIndex];
    const match = line.match(/!\[([^\]]*)\]\(([^)]+)\)/);
    if (!match) return null;

    const alt = match[1];
    const url = match[2];

    const imageNode = createNode('Image', {
      name: alt || url,
      filePath,
      url,
      alt,
      startLine: startIndex + 1,
    });

    const nodes: GraphNode[] = [imageNode];
    const edges: GraphRelationship[] = [];

    if (context.currentHeadingId) {
      edges.push(createEdge('HAS_IMAGE', context.currentHeadingId, imageNode.id, {}));
    }

    return { nodes, edges, nextIndex: startIndex + 1 };
  }
}

class TodoParser implements SectionParser {
  name = 'todo';

  parse(lines: string[], startIndex: number, filePath: string, context: any) {
    const line = lines[startIndex];
    const todoMatch = line.match(/(TODO|FIXME|HACK|XXX|NOTE)[:\s]+(.*)/i);
    if (!todoMatch) return null;

    const todoType = todoMatch[1].toUpperCase();
    const text = todoMatch[2].trim();

    const todoNode = createNode('Todo', {
      name: `${todoType}: ${text.slice(0, 50)}`,
      filePath,
      todoType,
      content: text,
      startLine: startIndex + 1,
    });

    const nodes: GraphNode[] = [todoNode];
    const edges: GraphRelationship[] = [];

    if (context.currentHeadingId) {
      edges.push(createEdge('HAS_TODO', context.currentHeadingId, todoNode.id, {}));
    }

    return { nodes, edges, nextIndex: startIndex + 1 };
  }
}

class TableParser implements SectionParser {
  name = 'table';

  parse(lines: string[], startIndex: number, filePath: string, context: any) {
    const line = lines[startIndex];
    // 检查是否是表格行（包含 |）
    if (!line.includes('|')) return null;

    // 检查下一行是否是分隔行
    if (startIndex + 1 >= lines.length) return null;
    const nextLine = lines[startIndex + 1];
    if (!nextLine.match(/^\|[\s\-:|]+\|$/)) return null;

    const tableNode = createNode('Table', {
      name: `table-${startIndex + 1}`,
      filePath,
      startLine: startIndex + 1,
      header: line,
    });

    const nodes: GraphNode[] = [tableNode];
    const edges: GraphRelationship[] = [];

    if (context.currentHeadingId) {
      edges.push(createEdge('HAS_TABLE', context.currentHeadingId, tableNode.id, {}));
    }

    return { nodes, edges, nextIndex: startIndex + 2 };
  }
}

// ========= 内置 Profile =========

const genericParsers: SectionParser[] = [
  new HeadingParser(),
  new CodeBlockParser(),
  new LinkParser(),
  new ImageParser(),
  new TodoParser(),
  new TableParser(),
];

export const genericProfile: MarkdownProfile = {
  name: 'generic',
  detect: () => true, // 默认匹配所有 MD 文件
  parsers: genericParsers,
  priority: 0,
};

export const apiDocsProfile: MarkdownProfile = {
  name: 'api-docs',
  detect: (content: string) => {
    return (
      content.includes('@api') ||
      content.includes('## API') ||
      content.includes('## Endpoints') ||
      content.includes('swagger') ||
      content.includes('openapi')
    );
  },
  parsers: [
    ...genericParsers,
    // 可以添加 API 特定的解析器
  ],
  priority: 10,
};

export const adrProfile: MarkdownProfile = {
  name: 'adr',
  detect: (content: string) => {
    return (
      (content.includes('## Status') && content.includes('## Context')) ||
      content.includes('Architecture Decision Record')
    );
  },
  parsers: genericParsers,
  priority: 10,
};

// ========= 插件主类 =========

export class MarkdownPlugin implements ParserPlugin, AnalyzerPlugin {
  name = 'gitnexus-markdown-plugin';
  version = '1.0.0';
  description = 'Markdown plugin with Profile-based customizable parsing';
  extensions = ['.md', '.markdown'];
  languages = ['markdown'];

  private profiles: MarkdownProfile[] = [genericProfile, apiDocsProfile, adrProfile];
  private currentProfile: MarkdownProfile | null = null;

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: GraphNode[] = [];
    const edges: GraphRelationship[] = [];

    // 创建文档节点
    const docNode = createNode('MarkdownDoc', {
      name: filePath.split('/').pop() || 'unknown',
      filePath,
    });
    nodes.push(docNode);

    // 检测文档类型（使用优先级最高的匹配 Profile）
    this.currentProfile = this.detectProfile(content, filePath);

    // 使用 Profile 的解析器解析
    const context = { currentHeadingId: docNode.id };
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      let parsed = false;

      // 尝试所有解析器
      for (const parser of this.currentProfile.parsers) {
        const result = parser.parse(lines, i, filePath, context);
        if (result) {
          nodes.push(...result.nodes);
          edges.push(...result.edges);
          i = result.nextIndex - 1; // -1 因为循环会 i++
          parsed = true;
          break;
        }
      }

      // 如果没解析，检查是否为标题（标题解析器可能失败）
      if (!parsed && lines[i].match(/^(#{1,6})\s+/)) {
        // 回到标题解析器
        const headingParser = new HeadingParser();
        const result = headingParser.parse(lines, i, filePath, context);
        if (result) {
          nodes.push(...result.nodes);
          edges.push(...result.edges);
          i = result.nextIndex - 1;
        }
      }
    }

    return {
      nodes,
      edges,
      metadata: {
        format: 'markdown',
        filePath,
        profile: this.currentProfile?.name || 'generic',
      },
    };
  }

  async analyze(
    node: any,
    context: AnalysisContext,
  ): Promise<{ results: AnalysisResultItem[]; metadata: Record<string, any> }> {
    const results: AnalysisResultItem[] = [];

    // 分析文档结构
    if (node.label === 'MarkdownDoc') {
      results.push({
        type: 'markdown.doc',
        name: node.properties.name,
        location: {
          filePath: context.filePath,
          startLine: 1,
        },
        properties: {
          profile: this.currentProfile?.name || 'generic',
        },
      });
    }

    return {
      results,
      metadata: {
        analyzer: this.name,
        language: context.language,
        profile: this.currentProfile?.name,
      },
    };
  }

  private detectProfile(content: string, filePath: string): MarkdownProfile {
    // 按优先级排序（高的优先）
    const sortedProfiles = [...this.profiles].sort((a, b) => (b.priority || 0) - (a.priority || 0));

    for (const profile of sortedProfiles) {
      if (profile.detect(content, filePath)) {
        return profile;
      }
    }

    return genericProfile; // 默认
  }

  // 允许动态添加 Profile
  registerProfile(profile: MarkdownProfile): void {
    this.profiles.push(profile);
  }

  register(registry: ParserRegistry | AnalyzerRegistry): void {
    if ('registerParser' in registry) {
      registry.registerParser(this);
    } else if ('registerAnalyzer' in registry) {
      registry.registerAnalyzer(this);
    }
  }

  supports(filePath: string): boolean {
    return this.extensions.some((ext) => filePath.endsWith(ext));
  }

  supportsLanguage(language: string): boolean {
    return this.languages.includes(language);
  }

  async init(config: any): Promise<void> {
    // 从配置加载自定义 Profile
    if (config?.customProfiles) {
      for (const profile of config.customProfiles) {
        this.registerProfile(profile);
      }
    }
    console.log(`Markdown plugin initialized with ${this.profiles.length} profiles`);
  }

  async dispose(): Promise<void> {
    this.profiles = [genericProfile]; // 重置为默认
  }
}

export default new MarkdownPlugin();
