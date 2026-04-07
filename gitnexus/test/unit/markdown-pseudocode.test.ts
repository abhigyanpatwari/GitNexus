import { describe, it, expect } from 'vitest';
import { processMarkdown } from '../../src/core/ingestion/markdown-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { generateId } from '../../src/lib/utils.js';

/**
 * Helper: Setup a graph with a File node for the given path,
 * then run processMarkdown on it.
 */
const setupAndProcess = (filePath: string, content: string) => {
  const graph = createKnowledgeGraph();
  const fileNodeId = generateId('File', filePath);
  graph.addNode({
    id: fileNodeId,
    label: 'File',
    properties: { name: filePath.split('/').pop()!, filePath },
  });
  const result = processMarkdown(graph, [{ path: filePath, content }], new Set([filePath]));
  return { graph, result };
};

describe('Markdown pseudocode extraction', () => {
  it('should extract definedSymbols from function definitions in code blocks', () => {
    const md = `# Architecture

\`\`\`typescript
async function buildNamespaceMap(repoPath: string) {
  const entries = await glob('**/.git');
  return entries;
}
\`\`\`
`;
    const { graph } = setupAndProcess('design.md', md);
    const codeElements = graph.nodes.filter(n => n.label === 'CodeElement');
    expect(codeElements).toHaveLength(1);
    expect(codeElements[0].properties.definedSymbols).toContain('buildNamespaceMap');
    expect(codeElements[0].properties.isPseudocode).toBe(true);
  });

  it('should extract calledSymbols from function calls in code blocks', () => {
    const md = `# Usage

\`\`\`typescript
const map = buildNamespaceMap(path);
const ns = resolveNamespace(filePath, map);
\`\`\`
`;
    const { graph } = setupAndProcess('usage.md', md);
    const codeElements = graph.nodes.filter(n => n.label === 'CodeElement');
    expect(codeElements).toHaveLength(1);
    const calledSymbols = codeElements[0].properties.calledSymbols as string[];
    expect(calledSymbols).toContain('buildNamespaceMap');
    expect(calledSymbols).toContain('resolveNamespace');
  });

  it('should set isPseudocode = true for code blocks in .md files', () => {
    const md = `# Test
\`\`\`python
def process():
    pass
\`\`\`
`;
    const { graph } = setupAndProcess('spec.md', md);
    const codeElements = graph.nodes.filter(n => n.label === 'CodeElement');
    expect(codeElements).toHaveLength(1);
    expect(codeElements[0].properties.isPseudocode).toBe(true);
    expect(codeElements[0].properties.nodeCategory).toBe('documentation');
  });

  it('should NOT create CodeElement nodes for .md files without code blocks', () => {
    const md = `# Just Prose

This document has no code blocks at all.
Just regular text and inline \`code\` mentions.
`;
    const { graph } = setupAndProcess('prose.md', md);
    const codeElements = graph.nodes.filter(n => n.label === 'CodeElement');
    expect(codeElements).toHaveLength(0);
  });

  it('should handle multiple code blocks in a single section', () => {
    const md = `# Pipeline

\`\`\`typescript
function stepOne() {
  return scan();
}
\`\`\`

Some explanation here.

\`\`\`typescript
function stepTwo() {
  return transform();
}
\`\`\`

More text.

\`\`\`typescript
function stepThree() {
  return output();
}
\`\`\`
`;
    const { graph } = setupAndProcess('pipeline.md', md);
    const codeElements = graph.nodes.filter(n => n.label === 'CodeElement');
    expect(codeElements).toHaveLength(3);
    const allDefined = codeElements.flatMap(n => n.properties.definedSymbols as string[]);
    expect(allDefined).toContain('stepOne');
    expect(allDefined).toContain('stepTwo');
    expect(allDefined).toContain('stepThree');
  });

  it('should filter out common built-in calls from calledSymbols', () => {
    const md = `# Example
\`\`\`typescript
function demo() {
  console.log("hello");
  const x = parseInt("42");
  const result = customProcess(data);
}
\`\`\`
`;
    const { graph } = setupAndProcess('example.md', md);
    const codeElement = graph.nodes.find(n => n.label === 'CodeElement');
    const calledSymbols = codeElement!.properties.calledSymbols as string[];
    // Built-ins should be filtered
    expect(calledSymbols).not.toContain('console');
    expect(calledSymbols).not.toContain('parseInt');
    // Custom call should remain
    expect(calledSymbols).toContain('customProcess');
  });

  it('should not include definedSymbols in calledSymbols (self-reference filter)', () => {
    const md = `# Recursive
\`\`\`typescript
function walkTree(node) {
  walkTree(node.left);
  walkTree(node.right);
}
\`\`\`
`;
    const { graph } = setupAndProcess('recursive.md', md);
    const codeElement = graph.nodes.find(n => n.label === 'CodeElement');
    const defined = codeElement!.properties.definedSymbols as string[];
    const called = codeElement!.properties.calledSymbols as string[];
    expect(defined).toContain('walkTree');
    // walkTree should be filtered from calledSymbols since it's defined in same block
    expect(called).not.toContain('walkTree');
  });

  it('should store rawContent as the code block value', () => {
    const codeContent = 'const x = 1;\nconst y = 2;';
    const md = `# Data
\`\`\`javascript
${codeContent}
\`\`\`
`;
    const { graph } = setupAndProcess('data.md', md);
    const codeElement = graph.nodes.find(n => n.label === 'CodeElement');
    expect(codeElement!.properties.rawContent).toBe(codeContent);
  });

  it('should set docType to design for code blocks', () => {
    const md = `# Arch
\`\`\`typescript
function init() {}
\`\`\`
`;
    const { graph } = setupAndProcess('arch.md', md);
    const codeElement = graph.nodes.find(n => n.label === 'CodeElement');
    expect(codeElement!.properties.docType).toBe('design');
  });

  it('should create Section nodes for headings', () => {
    const md = `# Title

## Overview

Some content.

## Architecture

More content.

### Sub-Section

Details.
`;
    const { graph, result } = setupAndProcess('doc.md', md);
    expect(result.sections).toBe(4); // Title, Overview, Architecture, Sub-Section
    const sections = graph.nodes.filter(n => n.label === 'Section');
    expect(sections).toHaveLength(4);
    // All sections should have documentation metadata
    for (const section of sections) {
      expect(section.properties.nodeCategory).toBe('documentation');
      expect(section.properties.isPseudocode).toBe(false);
      expect(section.properties.docType).toBe('design');
    }
  });

  it('should create CONTAINS edges from parent section to child section', () => {
    const md = `# Root

## Child
`;
    const { graph } = setupAndProcess('hierarchy.md', md);
    const containsEdges = graph.relationships.filter(r => r.type === 'CONTAINS');
    // File -> Root Section, Root Section -> Child Section
    expect(containsEdges.length).toBeGreaterThanOrEqual(2);
  });

  it('should create CONTAINS edges from section to enclosed code block', () => {
    const md = `# Design

\`\`\`typescript
function test() {}
\`\`\`
`;
    const { graph } = setupAndProcess('design.md', md);
    const section = graph.nodes.find(n => n.label === 'Section');
    const codeElement = graph.nodes.find(n => n.label === 'CodeElement');
    const containsEdge = graph.relationships.find(
      r => r.type === 'CONTAINS' && r.sourceId === section!.id && r.targetId === codeElement!.id
    );
    expect(containsEdge).toBeDefined();
    expect(containsEdge!.confidence).toBe(0.98);
    expect(containsEdge!.reason).toBe('structural-containment');
  });

  it('should skip non-markdown files', () => {
    const graph = createKnowledgeGraph();
    const result = processMarkdown(
      graph,
      [{ path: 'script.py', content: '# This is Python, not markdown' }],
      new Set(['script.py'])
    );
    expect(result.sections).toBe(0);
  });

  it('should create CALLS edges between pseudocode blocks when one calls another', () => {
    const md = `# Pipeline

\`\`\`typescript
function buildMap() {
  return scan();
}
\`\`\`

\`\`\`typescript
function runPipeline() {
  const map = buildMap();
}
\`\`\`
`;
    const { graph } = setupAndProcess('pipeline.md', md);
    const callsEdges = graph.relationships.filter(r => r.type === 'CALLS');
    // runPipeline calls buildMap — both defined in same file's code blocks
    expect(callsEdges.length).toBeGreaterThanOrEqual(1);
    const crossBlockCall = callsEdges.find(r => r.reason === 'pseudocode-call');
    expect(crossBlockCall).toBeDefined();
    expect(crossBlockCall!.confidence).toBe(0.90);
  });

  it('should add unresolved calls to pendingResolutions', () => {
    const md = `# Usage
\`\`\`typescript
function process() {
  const data = fetchRemoteData();
}
\`\`\`
`;
    const { result } = setupAndProcess('usage.md', md);
    // fetchRemoteData is not defined in this file, so it should be pending
    const pending = result.pendingResolutions.find(p => p.name === 'fetchRemoteData');
    expect(pending).toBeDefined();
    expect(pending!.sourceContext).toBe('usage.md');
  });
});
