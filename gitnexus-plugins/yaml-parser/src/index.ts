import * as path from 'path';
import * as yaml from 'js-yaml';
import { ParserPlugin, ParserRegistry, ParseResult } from 'gitnexus-shared';

interface YamlNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

interface YamlEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  reason: string;
}

function walkYaml(
  data: unknown,
  parentId: string,
  filePath: string,
  nodes: YamlNode[],
  edges: YamlEdge[],
  depth: number,
): void {
  if (data === null || data === undefined) return;

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const item = data[i];
      const nodeId = `${parentId}[${i}]`;

      if (typeof item !== 'object' || item === null) {
        nodes.push({
          id: nodeId,
          label: 'YamlArrayItem',
          properties: {
            index: i,
            value: item === null ? 'null' : String(item),
            configType: item === null ? 'null' : typeof item,
            filePath,
            depth,
          },
        });
      } else {
        nodes.push({
          id: nodeId,
          label: 'YamlArrayItem',
          properties: { index: i, filePath, depth },
        });
        walkYaml(item, nodeId, filePath, nodes, edges, depth + 1);
      }

      edges.push({
        id: `${parentId}->${nodeId}`,
        sourceId: parentId,
        targetId: nodeId,
        type: 'CONTAINS',
        confidence: 1.0,
        reason: 'yaml-array-item',
      });
    }
  } else if (typeof data === 'object' && data !== null) {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const nodeId = `${parentId}:${key}`;

      if (typeof value === 'object' && value !== null) {
        nodes.push({
          id: nodeId,
          label: 'YamlSection',
          properties: { key, filePath, depth, configType: 'group' },
        });
        walkYaml(value, nodeId, filePath, nodes, edges, depth + 1);
      } else {
        nodes.push({
          id: nodeId,
          label: 'YamlProperty',
          properties: {
            key,
            value: value === null ? 'null' : String(value),
            configType:
              value === null
                ? 'null'
                : typeof value === 'number'
                  ? 'number'
                  : typeof value === 'boolean'
                    ? 'boolean'
                    : 'string',
            filePath,
            depth,
          },
        });
      }

      edges.push({
        id: `${parentId}->${nodeId}`,
        sourceId: parentId,
        targetId: nodeId,
        type: 'CONTAINS',
        confidence: 1.0,
        reason: 'yaml-hierarchy',
      });
    }
  }
}

const yamlParserPlugin: ParserPlugin = {
  name: 'gitnexus-yaml-parser-plugin',
  version: '1.0.0',
  description:
    'Parse YAML/YML configuration files and extract configuration keys, values and structure',

  extensions: ['.yml', '.yaml'],

  supports(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    return ext === '.yml' || ext === '.yaml';
  },

  register(registry: ParserRegistry): void {
    registry.registerParser(this);
  },

  async parse(content: string, filePath: string): Promise<ParseResult> {
    const nodes: YamlNode[] = [];
    const edges: YamlEdge[] = [];

    try {
      const data = yaml.load(content);

      if (data === undefined || data === null) {
        return { nodes: [], edges: [], metadata: { type: 'yaml', filePath } };
      }

      const rootId = `yaml:${filePath}`;
      nodes.push({
        id: rootId,
        label: 'YamlConfig',
        properties: {
          name: path.basename(filePath),
          filePath,
          configType: 'yaml',
        },
      });

      if (typeof data === 'object') {
        walkYaml(data, rootId, filePath, nodes, edges, 1);
      } else {
        const valueId = `${rootId}:value`;
        nodes.push({
          id: valueId,
          label: 'YamlProperty',
          properties: {
            key: path.basename(filePath),
            value: String(data),
            configType: typeof data,
            filePath,
            depth: 1,
          },
        });
        edges.push({
          id: `${rootId}->${valueId}`,
          sourceId: rootId,
          targetId: valueId,
          type: 'CONTAINS',
          confidence: 1.0,
          reason: 'yaml-hierarchy',
        });
      }

      return { nodes, edges, metadata: { type: 'yaml', filePath } };
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        metadata: { type: 'yaml', filePath, error: (error as Error).message },
        error: (error as Error).message,
      };
    }
  },
};

export default yamlParserPlugin;
