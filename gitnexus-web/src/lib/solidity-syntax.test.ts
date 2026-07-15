import { describe, expect, it } from 'vitest';
import { getSyntaxLanguageFromFilename } from 'gitnexus-shared';

describe('getSyntaxLanguageFromFilename — Solidity', () => {
  it('maps .sol to Prism language "solidity"', () => {
    expect(getSyntaxLanguageFromFilename('contracts/Token.sol')).toBe('solidity');
    expect(getSyntaxLanguageFromFilename('path\\Vault.sol')).toBe('solidity');
  });
});
