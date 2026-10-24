import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { emitKotlinScopeCaptures } from '../../src/core/ingestion/languages/kotlin/captures.js';
import {
  clearCompanionScopes,
  companionHasNoSupertypes,
  getCompanionScopesForFile,
  isCompanionScope,
} from '../../src/core/ingestion/languages/kotlin/companion-scopes.js';
import {
  applyKotlinCaptureSideChannel,
  collectKotlinCaptureSideChannel,
} from '../../src/core/ingestion/languages/kotlin/capture-side-channel.js';

const filePath = 'companion-carrier.kt';
beforeEach(clearCompanionScopes);
afterEach(clearCompanionScopes);

it.each([
  { header: '', noSupertypes: true },
  { header: ': lib.Base()', noSupertypes: false },
])(
  'preserves companion header proof through a serialized carrier: $header',
  ({ header, noSupertypes }) => {
    emitKotlinScopeCaptures('class Host { companion object ' + header + ' {}\n}', filePath);
    const scopes = getCompanionScopesForFile(filePath);
    expect(scopes).toHaveLength(1);
    const scope = scopes[0];
    if (scope === undefined) throw new Error('companion scope was not captured');
    const payload: unknown = JSON.parse(JSON.stringify(collectKotlinCaptureSideChannel(filePath)));
    clearCompanionScopes();
    applyKotlinCaptureSideChannel({ filePath, captureSideChannel: payload } as ParsedFile);
    expect(isCompanionScope(filePath, scope)).toBe(true);
    expect(companionHasNoSupertypes(filePath, scope)).toBe(noSupertypes);
  },
);

it('retains companion identity but refuses header proof from an older carrier', () => {
  emitKotlinScopeCaptures('class Host { companion object {}\n}', filePath);
  const scope = getCompanionScopesForFile(filePath)[0];
  if (scope === undefined) throw new Error('companion scope was not captured');
  const payload = JSON.parse(JSON.stringify(collectKotlinCaptureSideChannel(filePath))) as Record<
    string,
    unknown
  >;
  delete payload.companionScopesWithoutSupertypes;
  clearCompanionScopes();
  applyKotlinCaptureSideChannel({ filePath, captureSideChannel: payload } as ParsedFile);
  expect(isCompanionScope(filePath, scope)).toBe(true);
  expect(companionHasNoSupertypes(filePath, scope)).toBe(false);
});
