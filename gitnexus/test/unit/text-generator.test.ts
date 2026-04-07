import { describe, it, expect } from 'vitest';
import { generateEmbeddingText, generateBatchEmbeddingTexts } from '../../src/core/embeddings/text-generator.js';
import type { EmbeddableNode } from '../../src/core/embeddings/types.js';

describe('generateEmbeddingText — Section nodes', () => {
  it('should produce formatted text for Section label', () => {
    const node: EmbeddableNode = {
      id: 'Section:docs/README.md:L10:Overview',
      label: 'Section',
      name: 'Overview',
      filePath: 'docs/README.md',
      content: 'This section describes the architecture.',
    };
    const result = generateEmbeddingText(node);
    expect(result).toContain('Design Section: Overview');
    expect(result).toContain('File: README.md');
    expect(result).toContain('Directory: docs');
    expect(result).toContain('This section describes the architecture.');
  });

  it('should handle Section with empty content', () => {
    const node: EmbeddableNode = {
      id: 'Section:PLAN.md:L1:Title',
      label: 'Section',
      name: 'Title',
      filePath: 'PLAN.md',
      content: '',
    };
    const result = generateEmbeddingText(node);
    expect(result).toContain('Design Section: Title');
    expect(result).toContain('File: PLAN.md');
    // No content added when empty
    expect(result).not.toContain('\n\n');
  });

  it('should include directory for nested Section file path', () => {
    const node: EmbeddableNode = {
      id: 'Section:src/docs/guide.md:L5:Setup',
      label: 'Section',
      name: 'Setup',
      filePath: 'src/docs/guide.md',
      content: 'How to set up the project',
    };
    const result = generateEmbeddingText(node);
    expect(result).toContain('Directory: src/docs');
  });

  it('should truncate long Section content', () => {
    const longContent = 'A'.repeat(600);
    const node: EmbeddableNode = {
      id: 'Section:doc.md:L1:Long',
      label: 'Section',
      name: 'Long',
      filePath: 'doc.md',
      content: longContent,
    };
    const result = generateEmbeddingText(node);
    expect(result.length).toBeLessThan(longContent.length + 100);
    expect(result).toContain('...');
  });
});

describe('generateEmbeddingText — CodeElement nodes', () => {
  it('should produce "Pseudocode Spec" prefix when isPseudocode = true', () => {
    const node: EmbeddableNode = {
      id: 'CodeElement:plan.md:10-20',
      label: 'CodeElement',
      name: 'buildNamespaceMap',
      filePath: 'docs/plan.md',
      content: '',
      isPseudocode: true,
      rawContent: 'async function buildNamespaceMap(repoPath: string) {\n  // scan for .git\n}',
    };
    const result = generateEmbeddingText(node);
    expect(result).toContain('Pseudocode Spec: buildNamespaceMap');
    expect(result).toContain('File: plan.md');
    expect(result).toContain('Directory: docs');
    // Should use rawContent when isPseudocode
    expect(result).toContain('async function buildNamespaceMap');
  });

  it('should produce "Code Snippet" prefix when isPseudocode = false', () => {
    const node: EmbeddableNode = {
      id: 'CodeElement:utils.ts:5-10',
      label: 'CodeElement',
      name: 'helper',
      filePath: 'src/utils.ts',
      content: 'function helper() { return 42; }',
      isPseudocode: false,
    };
    const result = generateEmbeddingText(node);
    expect(result).toContain('Code Snippet: helper');
    expect(result).toContain('function helper()');
  });

  it('should use "Anonymous Block" when name is empty', () => {
    const node: EmbeddableNode = {
      id: 'CodeElement:doc.md:1-5',
      label: 'CodeElement',
      name: '',
      filePath: 'doc.md',
      content: 'const x = 1;',
      isPseudocode: true,
      rawContent: 'const x = 1;',
    };
    const result = generateEmbeddingText(node);
    expect(result).toContain('Anonymous Block');
  });

  it('should use content when isPseudocode is false and rawContent exists', () => {
    const node: EmbeddableNode = {
      id: 'CodeElement:test.md:1-5',
      label: 'CodeElement',
      name: 'func',
      filePath: 'test.md',
      content: 'regular content',
      isPseudocode: false,
      rawContent: 'raw pseudocode content',
    };
    const result = generateEmbeddingText(node);
    expect(result).toContain('regular content');
    expect(result).not.toContain('raw pseudocode content');
  });

  it('should handle CodeElement with no content and no rawContent', () => {
    const node: EmbeddableNode = {
      id: 'CodeElement:model.ts:User',
      label: 'CodeElement',
      name: 'User',
      filePath: 'src/model.ts',
      content: '',
    };
    const result = generateEmbeddingText(node);
    expect(result).toBeTruthy();
    expect(result).toContain('User');
  });
});

describe('generateBatchEmbeddingTexts — mixed labels', () => {
  it('should generate texts for mixed Section and CodeElement nodes', () => {
    const nodes: EmbeddableNode[] = [
      {
        id: 'Section:doc.md:L1:Intro',
        label: 'Section',
        name: 'Intro',
        filePath: 'doc.md',
        content: 'Introduction text',
      },
      {
        id: 'CodeElement:doc.md:5-10',
        label: 'CodeElement',
        name: 'setup',
        filePath: 'doc.md',
        content: 'function setup() {}',
        isPseudocode: true,
        rawContent: 'function setup() {}',
      },
      {
        id: 'Function:src/main.ts:main',
        label: 'Function',
        name: 'main',
        filePath: 'src/main.ts',
        content: 'function main() { console.log("hello"); }',
      },
    ];
    const results = generateBatchEmbeddingTexts(nodes);
    expect(results).toHaveLength(3);
    expect(results[0]).toContain('Design Section: Intro');
    expect(results[1]).toContain('Pseudocode Spec: setup');
    expect(results[2]).toContain('Function: main');
  });
});
