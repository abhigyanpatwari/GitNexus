/**
 * Vue import resolver — delegates to TypeScript's standard resolver.
 *
 * Vue <script> blocks use the same import syntax as TypeScript (including
 * tsconfig path aliases like `@/`), so no custom resolution logic is needed.
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { resolveStandard } from './standard.js';
import type { ImportResolverFn } from './types.js';

export const resolveVueImport: ImportResolverFn = (raw, fp, ctx) =>
  resolveStandard(raw, fp, ctx, SupportedLanguages.TypeScript);
