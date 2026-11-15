/** Opt-in views of MCP results. Never changes graph queries or default output. */
export const QUERY_RESPONSE_SECTIONS = ['processes', 'process_symbols', 'definitions'] as const;
export const CONTEXT_RESPONSE_SECTIONS = [
  'incoming',
  'outgoing',
  'processes',
  'chain',
  'routes',
  'typed_properties',
] as const;
export const CONTEXT_RELATION_TYPES = [
  'CALLS',
  'IMPORTS',
  'EXTENDS',
  'IMPLEMENTS',
  'MEMBER_OF',
  'USES',
  'DECLARES',
  'HAS_METHOD',
  'HAS_PROPERTY',
  'METHOD_OVERRIDES',
  'OVERRIDES',
  'METHOD_IMPLEMENTS',
  'ACCESSES',
  'ADVISED_BY',
] as const;

export interface McpResponseFilter {
  tool: 'query' | 'context';
  sections?: string[];
  relationTypes?: string[];
}

function selection(value: unknown, allowed: readonly string[], name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > allowed.length ||
    value.some((item) => typeof item !== 'string' || !allowed.includes(item))
  ) {
    throw new Error(`${name} must be a non-empty array containing only: ${allowed.join(', ')}.`);
  }
  return [...new Set(value)];
}

/** Validate before dispatch; unsupported group views must never silently ignore a filter. */
export function resolveMcpResponseFilter(
  tool: string,
  args: Record<string, unknown> | undefined,
): McpResponseFilter | undefined {
  if (tool !== 'query' && tool !== 'context') return undefined;
  const sections = selection(
    args?.response_sections,
    tool === 'query' ? QUERY_RESPONSE_SECTIONS : CONTEXT_RESPONSE_SECTIONS,
    'response_sections',
  );
  const relationTypes =
    tool === 'context'
      ? selection(args?.relationTypes, CONTEXT_RELATION_TYPES, 'relationTypes')
      : undefined;
  if (!sections && !relationTypes) return undefined;
  if (typeof args?.repo === 'string' && args.repo.trim().startsWith('@')) {
    throw new Error(
      'Response filters require a single indexed repository name or path, not @group routing.',
    );
  }
  if (
    sections &&
    relationTypes &&
    !sections.some((section) => section === 'incoming' || section === 'outgoing')
  ) {
    throw new Error('relationTypes requires incoming or outgoing in response_sections.');
  }
  return { tool, sections, relationTypes };
}

export function withoutMcpResponseFilterArgs(
  args: Record<string, unknown> | undefined,
  filter: McpResponseFilter | undefined,
): Record<string, unknown> | undefined {
  if (!filter || !args) return args;
  const backendArgs = { ...args };
  delete backendArgs.response_sections;
  if (filter.tool === 'context') delete backendArgs.relationTypes;
  return backendArgs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Remove only explicitly selectable data fields. Everything else survives,
 * including future warnings, identity, ambiguity, risk and epistemic fields.
 * Reference filtering is over the backend's existing bounded result, not a
 * new exhaustive search. Report omissions without reinterpreting graph totals.
 */
export function applyMcpResponseFilter(
  result: unknown,
  filter: McpResponseFilter | undefined,
): unknown {
  if (
    !filter ||
    !isRecord(result) ||
    'error' in result ||
    (filter.tool === 'context' && result.status !== 'found')
  )
    return result;

  const output = { ...result };
  const omittedSections: string[] = [];
  const omittedRelations: Record<string, string[]> = {};
  if (filter.sections) {
    const available = filter.tool === 'query' ? QUERY_RESPONSE_SECTIONS : CONTEXT_RESPONSE_SECTIONS;
    for (const section of available) {
      if (!filter.sections.includes(section) && Object.hasOwn(output, section)) {
        delete output[section];
        omittedSections.push(section);
      }
    }
  }
  if (filter.relationTypes) {
    const categories = new Set(filter.relationTypes.map((type) => type.toLowerCase()));
    for (const direction of ['incoming', 'outgoing']) {
      const refs = output[direction];
      if (!isRecord(refs)) continue;
      output[direction] = Object.fromEntries(
        Object.entries(refs).filter(([type]) => categories.has(type)),
      );
      const omitted = Object.keys(refs).filter((type) => !categories.has(type));
      if (omitted.length) omittedRelations[direction] = omitted;
    }
  }
  output.response_filter = {
    ...(filter.sections ? { sections: filter.sections } : {}),
    ...(filter.relationTypes ? { relationTypes: filter.relationTypes } : {}),
    omitted_sections: omittedSections,
    ...(Object.keys(omittedRelations).length ? { omitted_relations: omittedRelations } : {}),
    note: 'Filtered view of the existing result, not an exhaustive search. Omitted data is not evidence of absence. Remove filters to expand; existing limits and completeness signals still apply.',
  };
  return output;
}
