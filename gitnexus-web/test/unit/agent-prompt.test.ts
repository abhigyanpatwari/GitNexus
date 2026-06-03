import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PROMPT } from '../../src/core/llm/agent';
import {
  createGraphRAGTools,
  GRAPH_RAG_TOOL_NAMES,
  type GraphRAGBackend,
} from '../../src/core/llm/tools';
import { NODE_REF_REGEX } from '../../src/lib/grounding-patterns';

/** Legacy or phantom tool names that must not appear in the system prompt. */
const FORBIDDEN_TOOL_NAMES = [
  'hybrid_search',
  'semantic_search',
  'semantic_search_with_context',
  'execute_cypher',
  'execute_vector_cypher',
  'grep_code',
  'read_file',
  'get_graph_schema',
  'get_code_content',
  'get_codebase_stats',
] as const;

/**
 * No-op backend. createGraphRAGTools only captures these methods inside each tool's
 * async execute closure — it never invokes them at construction time — so empty
 * implementations are enough to build the tools and read their registered names.
 */
const stubBackend: GraphRAGBackend = {
  executeQuery: async () => [],
  search: async () => [],
  grep: async () => [],
  readFile: async () => '',
};

describe('BASE_SYSTEM_PROMPT tool parity', () => {
  it('documents every registered Graph RAG tool by exact name', () => {
    for (const name of GRAPH_RAG_TOOL_NAMES) {
      expect(BASE_SYSTEM_PROMPT).toContain(`\`${name}\``);
    }
  });

  it('keeps GRAPH_RAG_TOOL_NAMES in sync with the tools createGraphRAGTools registers', () => {
    const registered = createGraphRAGTools(stubBackend).map((t) => t.name);
    expect(registered.sort()).toEqual([...GRAPH_RAG_TOOL_NAMES].sort());
  });

  it('does not reference legacy or non-existent tool names', () => {
    for (const name of FORBIDDEN_TOOL_NAMES) {
      // Word-boundary match catches both backticked and bare-prose mentions.
      expect(BASE_SYSTEM_PROMPT).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('uses explicit file citation format expected by the UI parser', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/\[\[src\/[^\]]+:\d+-\d+\]\]/);
    expect(BASE_SYSTEM_PROMPT).not.toContain('[[file:line]]');
  });

  it('documents a parser-recognized symbol citation format', () => {
    // Use the UI parser's own allowlist (NODE_REF_REGEX) so this tracks the parser
    // instead of forking its label list. NODE_REF_REGEX is /g; use a non-global copy
    // so the match is stateless.
    expect(BASE_SYSTEM_PROMPT).toMatch(new RegExp(NODE_REF_REGEX.source));
  });

  it('documents typed node labels, not polymorphic CodeNode', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('MATCH (f:Function)');
    expect(BASE_SYSTEM_PROMPT).not.toContain('CodeNode');
    expect(BASE_SYSTEM_PROMPT).not.toContain('INHERITS');
  });

  it('clarifies highlight_in_graph is not a callable tool', () => {
    // Reword-proof, registry-level guarantee: the load-bearing fact is that
    // highlight_in_graph is not a registered tool, regardless of prompt phrasing.
    expect(GRAPH_RAG_TOOL_NAMES).not.toContain('highlight_in_graph');
    // The prompt still addresses it explicitly...
    expect(BASE_SYSTEM_PROMPT).toContain('highlight_in_graph');
    // ...and must never instruct the model to call it (guards an affirmative reword).
    expect(BASE_SYSTEM_PROMPT).not.toMatch(/\b(?:use|call|invoke)\s+`?highlight_in_graph/i);
  });
});
