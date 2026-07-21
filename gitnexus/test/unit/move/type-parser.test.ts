import { describe, it, expect } from 'vitest';
import { extractTypeNames } from '../../../src/core/move/type-parser.js';

describe('extractTypeNames', () => {
  it('returns [] for primitive types', () => {
    expect(extractTypeNames('u64')).toEqual([]);
    expect(extractTypeNames('address')).toEqual([]);
    expect(extractTypeNames('bool')).toEqual([]);
    expect(extractTypeNames('&signer')).toEqual([]);
  });

  it('returns the bare type name for a simple reference', () => {
    expect(extractTypeNames('CoinStore')).toEqual(['CoinStore']);
    expect(extractTypeNames('&CoinStore')).toEqual(['CoinStore']);
    expect(extractTypeNames('&mut CoinStore')).toEqual(['CoinStore']);
  });

  it('extracts both outer and inner types from generics', () => {
    expect(extractTypeNames('CoinStore<CoinType>')).toEqual(['CoinStore', 'CoinType']);
    expect(extractTypeNames('Object<Pool<Coin>>')).toEqual(['Object', 'Pool', 'Coin']);
  });

  it('handles qualified type names', () => {
    expect(extractTypeNames('aptos_framework::coin::CoinStore<T>')).toEqual([
      'aptos_framework::coin::CoinStore',
      'T',
    ]);
  });

  it('handles vectors and options', () => {
    expect(extractTypeNames('vector<u8>')).toEqual([]);
    expect(extractTypeNames('Option<Vault>')).toEqual(['Option', 'Vault']);
  });
});
