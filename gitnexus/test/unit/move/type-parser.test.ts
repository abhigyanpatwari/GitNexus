import { describe, it, expect } from 'vitest';
import { extractTypeNames } from '../../../src/core/move/type-parser.js';

describe('extractTypeNames', () => {
  it('returns [] for primitive types', () => {
    expect(extractTypeNames('u64')).toEqual([]);
    expect(extractTypeNames('address')).toEqual([]);
    expect(extractTypeNames('bool')).toEqual([]);
    expect(extractTypeNames('i64')).toEqual([]);
    expect(extractTypeNames('i256')).toEqual([]);
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

  it('handles tuple types without leaking parentheses', () => {
    expect(extractTypeNames('(u64, bool)')).toEqual([]);
    expect(extractTypeNames('(Coin, u64)')).toEqual(['Coin']);
  });

  it('handles Move 2 function types without leaking pipes', () => {
    expect(extractTypeNames('|u64|u64')).toEqual([]);
    expect(extractTypeNames('|Coin|bool')).toEqual(['Coin']);
    expect(extractTypeNames('|&mut Vault|u64')).toEqual(['Vault']);
  });

  it('does not treat function-type abilities as nominal types', () => {
    expect(extractTypeNames('|u64|bool has copy + drop')).toEqual([]);
    expect(extractTypeNames('|Coin|Vault has store + key')).toEqual(['Coin', 'Vault']);
    expect(
      extractTypeNames('0x1::table::Table<address, |address, u64|bool has copy + drop + store>'),
    ).toEqual(['0x1::table::Table']);
    expect(extractTypeNames('vector<|Coin|Vault has store + key>')).toEqual(['Coin', 'Vault']);
  });
});
