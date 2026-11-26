import { describe, expect, it } from 'vitest';
import { joinCppMemberOwner } from '../../src/core/ingestion/languages/cpp/member-owner.js';

describe('joinCppMemberOwner', () => {
  it('keeps a fully qualified declarator at global scope', () => {
    expect(joinCppMemberOwner([], ['N', 'Box'], false)).toBe('N.Box');
  });

  it('does not double-qualify a declarator that already names the enclosing namespace', () => {
    expect(joinCppMemberOwner(['N'], ['N', 'Box'], false)).toBe('N.Box');
    expect(joinCppMemberOwner(['N', 'N'], ['N', 'Box'], false)).toBe('N.N.Box');
  });

  it('prepends enclosing namespaces onto a one-segment relative declarator', () => {
    expect(joinCppMemberOwner(['N'], ['Box'], false)).toBe('N.Box');
    expect(joinCppMemberOwner(['N', 'M'], ['Box'], false)).toBe('N.M.Box');
    expect(joinCppMemberOwner(['@anon1'], ['Item'], false)).toBe('@anon1.Item');
  });

  it('does not prepend an enclosing namespace onto a different qualified path', () => {
    expect(joinCppMemberOwner(['M'], ['N', 'Box'], false)).toBe('N.Box');
  });

  it('honors a leading global anchor', () => {
    expect(joinCppMemberOwner(['N'], ['Box'], true)).toBe('Box');
    expect(joinCppMemberOwner(['N'], ['N', 'Box'], true)).toBe('N.Box');
  });

  it('preserves template arguments inside a declarator segment', () => {
    expect(joinCppMemberOwner(['A'], ['Box<std::string>'], false)).toBe('A.Box<std::string>');
    expect(joinCppMemberOwner(['A'], ['A', 'Box<std::string>'], false)).toBe('A.Box<std::string>');
  });
});
