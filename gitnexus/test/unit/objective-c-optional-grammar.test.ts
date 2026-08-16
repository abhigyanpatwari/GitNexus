import { describe, expect, it } from 'vitest';

import { getOptionalGrammarExtensions } from '../../src/cli/optional-grammars.js';

describe('Objective-C optional grammar preflight', () => {
  it('preflights only the unambiguous Objective-C implementation extension', () => {
    const extensions = getOptionalGrammarExtensions();
    expect(extensions).not.toContain('.h');
    expect(extensions).toContain('.m');
  });
});
