import { describe, expect, it } from 'vitest';
import { BASE_SYSTEM_PROMPT } from '../../src/core/llm/agent';
import { GRAPH_RAG_TOOL_NAMES } from '../../src/core/llm/tools';

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

describe('BASE_SYSTEM_PROMPT tool parity', () => {
  it('documents every registered Graph RAG tool by exact name', () => {
    for (const name of GRAPH_RAG_TOOL_NAMES) {
      expect(BASE_SYSTEM_PROMPT).toContain(`\`${name}\``);
    }
  });

  it('does not reference legacy or non-existent tool names', () => {
    for (const name of FORBIDDEN_TOOL_NAMES) {
      expect(BASE_SYSTEM_PROMPT).not.toContain(`\`${name}\``);
    }
  });

  it('uses explicit file citation format expected by the UI parser', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/\[\[src\/[^\]]+:\d+-\d+\]\]/);
    expect(BASE_SYSTEM_PROMPT).not.toContain('[[file:line]]');
  });

  it('documents typed node labels, not polymorphic CodeNode', () => {
    expect(BASE_SYSTEM_PROMPT).toContain('MATCH (f:Function)');
    expect(BASE_SYSTEM_PROMPT).not.toContain('CodeNode');
    expect(BASE_SYSTEM_PROMPT).not.toContain('INHERITS');
  });

  it('clarifies highlight_in_graph is not a callable tool', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/highlight_in_graph.*not.*tool|NO.*highlight_in_graph/i);
  });
});
