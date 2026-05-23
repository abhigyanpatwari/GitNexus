import { describe, expect, it } from 'vitest';
import { SupportedLanguages, getLanguageFromFilename } from 'gitnexus-shared';
import { getProviderForFile } from '../../src/core/ingestion/languages/index.js';
import { extractParsedFile } from '../../src/core/ingestion/scope-extractor-bridge.js';

const parseWithWarnings = (filePath: string, source: string) => {
  const provider = getProviderForFile(filePath);
  expect(provider?.id).toBe(SupportedLanguages.PHP);

  const warnings: string[] = [];
  const parsed = extractParsedFile(provider!, source, filePath, (message) => {
    warnings.push(message);
  });

  return { parsed, warnings };
};

describe('PHP template scope extraction', () => {
  it('keeps Magento/Mage-OS PHTML templates on PHP scope extraction without module warnings', () => {
    const filePath = 'vendor/mage-os/module-catalog/view/frontend/templates/product/list.phtml';
    const source = `<div><?= $block->getChildHtml() ?></div>
<?php echo $escaper->escapeHtml($title); ?>`;

    expect(getLanguageFromFilename(filePath)).toBe(SupportedLanguages.PHP);

    const { parsed, warnings } = parseWithWarnings(filePath, source);

    expect(warnings).toEqual([]);
    expect(parsed?.scopes[0]?.kind).toBe('Module');
    expect(parsed?.referenceSites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'getChildHtml',
          kind: 'call',
          callForm: 'member',
          explicitReceiver: { name: '$block' },
        }),
        expect.objectContaining({
          name: 'escapeHtml',
          kind: 'call',
          callForm: 'member',
          explicitReceiver: { name: '$escaper' },
        }),
      ]),
    );
  });

  it('keeps namespace-less PHP config files module-scoped without module warnings', () => {
    const filePath = 'config/database.php';
    const source = `<?php
return [
    'driver' => env('DB_CONNECTION', 'mysql'),
];`;

    expect(getLanguageFromFilename(filePath)).toBe(SupportedLanguages.PHP);

    const { parsed, warnings } = parseWithWarnings(filePath, source);

    expect(warnings).toEqual([]);
    expect(parsed?.scopes[0]?.kind).toBe('Module');
    expect(parsed?.referenceSites).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'env',
          kind: 'call',
          callForm: 'free',
          arity: 2,
        }),
      ]),
    );
  });
});
