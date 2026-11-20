import { normalizeRouterAliases } from './go/route-config.js';

// The CLI reads config before analysis. Register only option descriptors and
// validators here so reading .gitnexusrc does not load parsers or providers.
export const providerAnalyzeConfig = {
  goRouterAliases: { target: 'routeFrameworkAliases', normalize: normalizeRouterAliases },
  goHandlerWrappers: { target: 'routeHandlerWrappers', kind: 'string-array' },
} as const;
