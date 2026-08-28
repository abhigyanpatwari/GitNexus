import {
  MODULE_SYSTEM_PROMPT,
  MODULE_USER_PROMPT,
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_USER_PROMPT,
  PARENT_SYSTEM_PROMPT,
  PARENT_USER_PROMPT,
} from '../../prompts.js';
import type { PromptSpec, TemplateProfile } from '../types.js';

function prompt(system: string, user: string, variables: readonly string[]): PromptSpec {
  return {
    system,
    user,
    requiredVariables: variables,
    allowedVariables: variables,
  };
}

export const DEFAULT_TEMPLATE_PROFILE: TemplateProfile = {
  schemaVersion: 1,
  id: 'default',
  revision: 1,
  displayName: {
    en: 'Default Wiki',
    'zh-CN': '默认 Wiki',
  },
  alignments: [],
  grouping: 'shared-default',
  sections: [
    {
      id: 'overview',
      title: { en: 'Overview', 'zh-CN': '概览' },
      required: true,
      concerns: ['repository purpose', 'architecture', 'key flows'],
      evidenceRequirements: [],
      unknownPolicy: 'emit-status',
    },
    {
      id: 'module',
      title: { en: 'Modules', 'zh-CN': '模块' },
      required: true,
      concerns: ['module purpose', 'components', 'dependencies'],
      evidenceRequirements: [],
      unknownPolicy: 'emit-status',
    },
  ],
  prompts: {
    module: prompt(MODULE_SYSTEM_PROMPT, MODULE_USER_PROMPT, [
      'MODULE_NAME',
      'SOURCE_CODE',
      'INTRA_CALLS',
      'OUTGOING_CALLS',
      'INCOMING_CALLS',
      'PROCESSES',
    ]),
    parent: prompt(PARENT_SYSTEM_PROMPT, PARENT_USER_PROMPT, [
      'MODULE_NAME',
      'CHILDREN_DOCS',
      'CROSS_MODULE_CALLS',
      'CROSS_PROCESSES',
    ]),
    overview: prompt(OVERVIEW_SYSTEM_PROMPT, OVERVIEW_USER_PROMPT, [
      'PROJECT_INFO',
      'MODULE_SUMMARIES',
      'MODULE_EDGES',
      'TOP_PROCESSES',
    ]),
  },
  diagramPolicy: {
    allowed: true,
    maxNodes: 10,
    kinds: ['mermaid-flowchart', 'mermaid-sequence'],
  },
  output: {
    topology: 'legacy-tree',
    entryFile: 'overview.md',
    coverageFile: 'coverage.json',
  },
};
