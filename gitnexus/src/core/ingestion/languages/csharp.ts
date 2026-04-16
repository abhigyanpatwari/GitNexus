/**
 * C# language provider.
 *
 * C# uses named imports (using directives), modifier-based export detection,
 * and an implements-split MRO strategy for multiple interface implementation.
 * Interface names follow the I-prefix convention (e.g., IDisposable).
 */

import { SupportedLanguages } from 'gitnexus-shared';
import { createClassExtractor } from '../class-extractors/generic.js';
import { csharpClassConfig } from '../class-extractors/configs/csharp.js';
import { defineLanguage } from '../language-provider.js';
import { typeConfig as csharpConfig } from '../type-extractors/csharp.js';
import { csharpExportChecker } from '../export-detection.js';
import { resolveCSharpImport } from '../import-resolvers/csharp.js';
import { extractCSharpNamedBindings } from '../named-bindings/csharp.js';
import { CSHARP_QUERIES } from '../tree-sitter-queries.js';
import { createCallExtractor } from '../call-extractors/generic.js';
import { csharpCallConfig } from '../call-extractors/configs/csharp.js';
import { createFieldExtractor } from '../field-extractors/generic.js';
import { csharpConfig as csharpFieldConfig } from '../field-extractors/configs/csharp.js';
import { createMethodExtractor } from '../method-extractors/generic.js';
import { csharpMethodConfig } from '../method-extractors/configs/csharp.js';
import { createVariableExtractor } from '../variable-extractors/generic.js';
import { csharpVariableConfig } from '../variable-extractors/configs/csharp.js';

const BUILT_INS: ReadonlySet<string> = new Set([
  'Console',
  'WriteLine',
  'ReadLine',
  'Write',
  'Task',
  'Run',
  'Wait',
  'WhenAll',
  'WhenAny',
  'FromResult',
  'Delay',
  'ContinueWith',
  'ConfigureAwait',
  'GetAwaiter',
  'GetResult',
  'ToString',
  'GetType',
  'Equals',
  'GetHashCode',
  'ReferenceEquals',
  'Add',
  'Remove',
  'Contains',
  'Clear',
  'Count',
  'Any',
  'All',
  'Where',
  'Select',
  'SelectMany',
  'OrderBy',
  'OrderByDescending',
  'GroupBy',
  'First',
  'FirstOrDefault',
  'Single',
  'SingleOrDefault',
  'Last',
  'LastOrDefault',
  'ToList',
  'ToArray',
  'ToDictionary',
  'AsEnumerable',
  'AsQueryable',
  'Aggregate',
  'Sum',
  'Average',
  'Min',
  'Max',
  'Distinct',
  'Skip',
  'Take',
  'String',
  'Format',
  'IsNullOrEmpty',
  'IsNullOrWhiteSpace',
  'Concat',
  'Join',
  'Trim',
  'TrimStart',
  'TrimEnd',
  'Split',
  'Replace',
  'StartsWith',
  'EndsWith',
  'Convert',
  'ToInt32',
  'ToDouble',
  'ToBoolean',
  'ToByte',
  'Math',
  'Abs',
  'Ceiling',
  'Floor',
  'Round',
  'Pow',
  'Sqrt',
  'Dispose',
  'Close',
  'TryParse',
  'Parse',
  'AddRange',
  'RemoveAt',
  'RemoveAll',
  'FindAll',
  'Exists',
  'TrueForAll',
  'ContainsKey',
  'TryGetValue',
  'AddOrUpdate',
  'Throw',
  'ThrowIfNull',
]);

export const csharpProvider = defineLanguage({
  id: SupportedLanguages.CSharp,
  extensions: ['.cs'],
  treeSitterQueries: CSHARP_QUERIES,
  typeConfig: csharpConfig,
  exportChecker: csharpExportChecker,
  importResolver: resolveCSharpImport,
  namedBindingExtractor: extractCSharpNamedBindings,
  interfaceNamePattern: /^I[A-Z]/,
  mroStrategy: 'implements-split',
  callExtractor: createCallExtractor(csharpCallConfig),
  fieldExtractor: createFieldExtractor(csharpFieldConfig),
  methodExtractor: createMethodExtractor(csharpMethodConfig),
  variableExtractor: createVariableExtractor(csharpVariableConfig),
  classExtractor: createClassExtractor(csharpClassConfig),
  builtInNames: BUILT_INS,
});
