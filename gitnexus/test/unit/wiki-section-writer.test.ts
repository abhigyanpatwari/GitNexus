import { describe, expect, it, vi } from 'vitest';

import { SectionWriter } from '../../src/core/wiki/document/section-writer.js';
import { assembleSectionPage } from '../../src/core/wiki/document/assembler.js';
import { createEvidencePresentation } from '../../src/core/wiki/document/evidence-presentation.js';
import { sanitizeMarkdownForViewer } from '../../src/core/wiki/html-viewer.js';
import { parseSectionDraftResponse } from '../../src/core/wiki/document/response-parser.js';
import { renderPrompt } from '../../src/core/wiki/profiles/render-prompt.js';
import { DEFAULT_TEMPLATE_PROFILE } from '../../src/core/wiki/profiles/builtins/default.js';
import type { PromptSpec } from '../../src/core/wiki/profiles/types.js';

const evidenceId = 'ev-1234567890abcdef1234';

describe('wiki structured response parser', () => {
  const valid = JSON.stringify({
    schemaVersion: 1,
    sectionId: 'architecture',
    blocks: [
      {
        type: 'claim',
        claim: {
          id: 'claim-architecture',
          text: 'The architecture has a core module.',
          status: 'verified',
          evidenceIds: [evidenceId],
          origin: 'llm',
        },
      },
    ],
  });

  it('parses raw JSON with only preallocated evidence ids', () => {
    expect(parseSectionDraftResponse(valid, 'architecture', new Set([evidenceId]))).toEqual({
      schemaVersion: 1,
      sectionId: 'architecture',
      blocks: [
        {
          type: 'claim',
          claim: {
            id: 'claim-architecture',
            text: 'The architecture has a core module.',
            status: 'verified',
            evidenceIds: [evidenceId],
            origin: 'llm',
          },
        },
      ],
    });
  });

  it('rejects Markdown fences, malformed JSON, schema drift, and section mismatch', () => {
    expect(() =>
      parseSectionDraftResponse(
        `\`\`\`json\n${valid}\n\`\`\``,
        'architecture',
        new Set([evidenceId]),
      ),
    ).toThrow('Structured section response must be raw JSON without Markdown fences');
    expect(() => parseSectionDraftResponse('{', 'architecture', new Set([evidenceId]))).toThrow(
      'Structured section response is not valid JSON',
    );

    const wrongSchema = JSON.stringify({ ...JSON.parse(valid), schemaVersion: 2 });
    expect(() =>
      parseSectionDraftResponse(wrongSchema, 'architecture', new Set([evidenceId])),
    ).toThrow('Unsupported section draft schemaVersion: 2');

    expect(() => parseSectionDraftResponse(valid, 'deployment', new Set([evidenceId]))).toThrow(
      'Section draft id mismatch: expected deployment, got architecture',
    );
  });

  it('rejects unknown fields, duplicate claim ids, and LLM-invented evidence ids', () => {
    const unknownField = JSON.stringify({ ...JSON.parse(valid), commentary: 'done' });
    expect(() =>
      parseSectionDraftResponse(unknownField, 'architecture', new Set([evidenceId])),
    ).toThrow('response contains unknown fields: commentary');

    const duplicate = JSON.parse(valid);
    duplicate.blocks.push(duplicate.blocks[0]);
    expect(() =>
      parseSectionDraftResponse(JSON.stringify(duplicate), 'architecture', new Set([evidenceId])),
    ).toThrow('Duplicate claim id: claim-architecture');

    const unknownEvidence = JSON.parse(valid);
    unknownEvidence.blocks[0].claim.evidenceIds = ['ev-invented'];
    expect(() =>
      parseSectionDraftResponse(
        JSON.stringify(unknownEvidence),
        'architecture',
        new Set([evidenceId]),
      ),
    ).toThrow('references unknown evidence id: ev-invented');
  });
});

describe('wiki SectionWriter modes', () => {
  it('keeps default in explicit legacy Markdown mode with the exact Prompt bytes', async () => {
    const writer = new SectionWriter();
    const invokeLLM = vi.fn().mockResolvedValue({ content: 'Legacy body.' });
    const payload = await writer.write({
      profileId: 'default',
      sectionId: 'module-core',
      prompt: DEFAULT_TEMPLATE_PROFILE.prompts.module,
      variables: {
        MODULE_NAME: 'Core',
        SOURCE_CODE: 'export const core = true;',
        INTRA_CALLS: 'None',
        OUTGOING_CALLS: 'None',
        INCOMING_CALLS: 'None',
        PROCESSES: 'No execution flows detected for this module.',
      },
      evidenceIds: [evidenceId],
      invokeLLM,
      transformSystemPrompt: (systemPrompt) => `${systemPrompt}\n\nLANGUAGE`,
    });

    expect(payload).toEqual({
      mode: 'legacy-markdown',
      markdown: 'Legacy body.',
      sectionEvidenceIds: [evidenceId],
      traceability: 'section-level',
    });
    // 校验传给 LLM 的是完整的 legacy prompt 字节(模块标题以外的任何 prompt 文本、空白
    // 或变量替换变化都应导致失败),而非仅断言包含模块标题子串
    const expectedUser = renderPrompt(DEFAULT_TEMPLATE_PROFILE.prompts.module, {
      MODULE_NAME: 'Core',
      SOURCE_CODE: 'export const core = true;',
      INTRA_CALLS: 'None',
      OUTGOING_CALLS: 'None',
      INCOMING_CALLS: 'None',
      PROCESSES: 'No execution flows detected for this module.',
    }).user;
    expect(invokeLLM).toHaveBeenCalledWith(
      expectedUser,
      `${DEFAULT_TEMPLATE_PROFILE.prompts.module.system}\n\nLANGUAGE`,
      undefined,
    );
  });

  it('requires non-default profiles to return strict structured JSON', async () => {
    const prompt: PromptSpec = {
      system: 'Return JSON.',
      user: 'Write {{SECTION_ID}} from {{EVIDENCE_BUNDLE}}.',
      requiredVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
      allowedVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
    };
    const writer = new SectionWriter();
    const invokeLLM = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        schemaVersion: 1,
        sectionId: 'architecture',
        blocks: [
          {
            type: 'unknown',
            status: 'needs-human',
            reason: 'No deployment evidence.',
            evidenceIds: [],
          },
        ],
      }),
    });

    await expect(
      writer.write({
        profileId: 'arc42',
        sectionId: 'architecture',
        prompt,
        variables: { SECTION_ID: 'architecture', EVIDENCE_BUNDLE: evidenceId },
        evidenceIds: [evidenceId],
        invokeLLM,
      }),
    ).resolves.toEqual({
      mode: 'structured',
      blocks: [
        {
          type: 'unknown',
          status: 'needs-human',
          reason: 'No deployment evidence.',
          evidenceIds: [],
        },
      ],
    });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
  });

  it('appends a visible repository-relative source table for engineering Wiki pages', async () => {
    const prompt: PromptSpec = {
      system: 'Return JSON.',
      user: 'Write {{SECTION_ID}} from {{EVIDENCE_BUNDLE}}.',
      requiredVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
      allowedVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
    };
    const writer = new SectionWriter();
    const invokeLLM = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        schemaVersion: 1,
        sectionId: 'project-overview',
        blocks: [
          {
            type: 'claim',
            claim: {
              id: 'claim-overview',
              text: 'The repository exposes a Wiki generator.',
              status: 'verified',
              evidenceIds: [evidenceId],
              origin: 'model-output',
            },
          },
        ],
      }),
    });
    const evidenceBundle = JSON.stringify([
      {
        id: evidenceId,
        kind: 'file',
        status: 'verified',
        filePath: 'src/core/wiki/generator.ts',
        symbol: 'WikiGenerator',
        summary: 'Wiki generation implementation',
      },
    ]);

    const payload = await writer.write({
      profileId: 'engineering-wiki',
      sectionId: 'project-overview',
      prompt,
      variables: { SECTION_ID: 'project-overview', EVIDENCE_BUNDLE: evidenceBundle },
      evidenceIds: [evidenceId],
      invokeLLM,
    });
    const viewerMarkdown = sanitizeMarkdownForViewer(
      assembleSectionPage('项目概述', payload, {
        evidence: createEvidencePresentation(
          {
            schemaVersion: 1,
            repoPath: '/repo',
            sourceCommit: 'abc123',
            collectedAt: '2026-08-12T00:00:00.000Z',
            repository: JSON.parse(evidenceBundle),
            modules: {},
            conflicts: [],
            limitations: [],
          },
          'zh-CN',
        ),
      }),
    );

    expect(payload).toMatchObject({
      mode: 'structured',
      blocks: [
        { type: 'claim', claim: { origin: 'llm' } },
        {
          type: 'table',
          headers: ['Source / 来源', 'Anchor / 锚点', 'Supports / 支持内容'],
        },
      ],
    });
    expect(viewerMarkdown).toContain('src/core/wiki/generator.ts');
    expect(viewerMarkdown).toContain('WikiGenerator');
    expect(viewerMarkdown).not.toContain(evidenceId);
    expect(viewerMarkdown).not.toContain('| Evidence |');
    expect(viewerMarkdown).not.toContain('/Users/');
  });

  it('repairs engineering overall architecture until a bounded Mermaid diagram exists', async () => {
    const prompt: PromptSpec = {
      system: 'Return JSON.',
      user: 'Write {{SECTION_ID}} from {{EVIDENCE_BUNDLE}}.',
      requiredVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
      allowedVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
    };
    const noDiagram = JSON.stringify({
      schemaVersion: 1,
      sectionId: 'overall-architecture',
      blocks: [
        {
          type: 'claim',
          claim: {
            id: 'claim-overall',
            text: 'The CLI invokes the generator.',
            status: 'verified',
            evidenceIds: [evidenceId],
            origin: 'llm',
          },
        },
      ],
    });
    const withDiagram = JSON.stringify({
      schemaVersion: 1,
      sectionId: 'overall-architecture',
      blocks: [
        {
          type: 'diagram',
          syntax: 'mermaid',
          source: 'flowchart LR\nCLI["CLI"] --> Generator["WikiGenerator"]',
          evidenceIds: [evidenceId],
        },
      ],
    });
    const invokeLLM = vi
      .fn()
      .mockResolvedValueOnce({ content: noDiagram })
      .mockResolvedValueOnce({ content: withDiagram });
    const writer = new SectionWriter();

    const payload = await writer.write({
      profileId: 'engineering-wiki',
      sectionId: 'overall-architecture',
      prompt,
      variables: {
        SECTION_ID: 'overall-architecture',
        EVIDENCE_BUNDLE: JSON.stringify([
          {
            id: evidenceId,
            filePath: 'src/core/wiki/generator.ts',
            symbol: 'WikiGenerator',
            summary: 'Wiki generator',
          },
        ]),
      },
      evidenceIds: [evidenceId],
      invokeLLM,
    });

    expect(payload).toMatchObject({
      mode: 'structured',
      blocks: [{ type: 'diagram' }, { type: 'table' }],
    });
    expect(invokeLLM).toHaveBeenCalledTimes(2);
    expect(invokeLLM.mock.calls[1][0]).toContain('must include one Mermaid flowchart');
  });

  it('repairs a fenced structured response with the strict contract', async () => {
    const prompt: PromptSpec = {
      system: 'Return JSON.',
      user: 'Write {{SECTION_ID}} from {{EVIDENCE_BUNDLE}}.',
      requiredVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
      allowedVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
    };
    const validResponse = JSON.stringify({
      schemaVersion: 1,
      sectionId: 'architecture',
      blocks: [
        {
          type: 'claim',
          claim: {
            id: 'claim-architecture',
            text: 'The architecture has a core module.',
            status: 'verified',
            evidenceIds: [evidenceId],
            origin: 'llm',
          },
        },
      ],
    });
    const writer = new SectionWriter();
    const invokeLLM = vi
      .fn()
      .mockResolvedValueOnce({ content: `\`\`\`json\n${validResponse}\n\`\`\`` })
      .mockResolvedValueOnce({ content: validResponse });

    await expect(
      writer.write({
        profileId: 'ieee-1016-sdd',
        sectionId: 'architecture',
        prompt,
        variables: { SECTION_ID: 'architecture', EVIDENCE_BUNDLE: evidenceId },
        evidenceIds: [evidenceId],
        invokeLLM,
      }),
    ).resolves.toMatchObject({ mode: 'structured' });
    expect(invokeLLM).toHaveBeenCalledTimes(2);
    expect(invokeLLM.mock.calls[0][1]).toContain('Do not use Markdown fences');
    expect(invokeLLM.mock.calls[1][0]).toContain('failed strict validation');
  });

  it('fails after two bounded repairs when every response is invalid', async () => {
    const prompt: PromptSpec = {
      system: 'Return JSON.',
      user: 'Write {{SECTION_ID}} from {{EVIDENCE_BUNDLE}}.',
      requiredVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
      allowedVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
    };
    const writer = new SectionWriter();
    const invokeLLM = vi.fn().mockResolvedValue({ content: 'not-json' });

    await expect(
      writer.write({
        profileId: 'arc42',
        sectionId: 'architecture',
        prompt,
        variables: { SECTION_ID: 'architecture', EVIDENCE_BUNDLE: evidenceId },
        evidenceIds: [evidenceId],
        invokeLLM,
      }),
    ).rejects.toThrow('Structured section response is not valid JSON');
    expect(invokeLLM).toHaveBeenCalledTimes(3);
  });

  it('countMermaidNodes 支持序列图的节点计数', async () => {
    const prompt: PromptSpec = {
      system: 'Return JSON.',
      user: 'Write {{SECTION_ID}} from {{EVIDENCE_BUNDLE}}.',
      requiredVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
      allowedVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
    };
    // sequence diagram 使用 ->> 和 -->> 消息箭头，以及 participant 声明
    const sequenceDiagram = JSON.stringify({
      schemaVersion: 1,
      sectionId: 'runtime-architecture',
      blocks: [
        {
          type: 'diagram',
          syntax: 'mermaid',
          source:
            'sequenceDiagram\nparticipant Client\nparticipant Server\nClient->>Server: Request\nServer-->>Client: Response',
          evidenceIds: [evidenceId],
        },
      ],
    });
    const writer = new SectionWriter();
    const invokeLLM = vi.fn().mockResolvedValue({ content: sequenceDiagram });

    const payload = await writer.write({
      profileId: 'engineering-wiki',
      sectionId: 'runtime-architecture',
      prompt,
      variables: {
        SECTION_ID: 'runtime-architecture',
        EVIDENCE_BUNDLE: JSON.stringify([
          {
            id: evidenceId,
            filePath: 'src/core.ts',
            symbol: 'run',
            summary: 'runtime flow',
          },
        ]),
      },
      evidenceIds: [evidenceId],
      invokeLLM,
    });

    // sequence diagram 不应因节点计数为 0 而被拒绝
    expect(payload).toMatchObject({
      mode: 'structured',
      blocks: [{ type: 'diagram' }, { type: 'table' }],
    });
    expect(invokeLLM).toHaveBeenCalledTimes(1);
  });

  it('repairs an empty generated section instead of publishing a title-only page', async () => {
    const prompt: PromptSpec = {
      system: 'Return JSON.',
      user: 'Write {{SECTION_ID}} from {{EVIDENCE_BUNDLE}}.',
      requiredVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
      allowedVariables: ['SECTION_ID', 'EVIDENCE_BUNDLE'],
    };
    const writer = new SectionWriter();
    const invokeLLM = vi
      .fn()
      .mockResolvedValueOnce({
        content: JSON.stringify({ schemaVersion: 1, sectionId: 'architecture', blocks: [] }),
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          schemaVersion: 1,
          sectionId: 'architecture',
          blocks: [
            {
              type: 'unknown',
              status: 'needs-human',
              reason: 'No deployment evidence.',
              evidenceIds: [],
            },
          ],
        }),
      });

    await expect(
      writer.write({
        profileId: 'iso-42010-ad',
        sectionId: 'architecture',
        prompt,
        variables: { SECTION_ID: 'architecture', EVIDENCE_BUNDLE: evidenceId },
        evidenceIds: [evidenceId],
        invokeLLM,
      }),
    ).resolves.toMatchObject({ mode: 'structured', blocks: [{ type: 'unknown' }] });
    expect(invokeLLM.mock.calls[1][0]).toContain('must contain at least one block');
  });
});
