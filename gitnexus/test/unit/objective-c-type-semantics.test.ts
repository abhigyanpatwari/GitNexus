import { describe, expect, it } from 'vitest';

import { parseObjectiveCTypeDescriptor } from '../../src/core/ingestion/languages/objective-c/type-semantics.js';

describe('Objective-C type semantics', () => {
  it('retains a concrete receiver base and its protocol qualifiers', () => {
    expect(parseObjectiveCTypeDescriptor('Foo<P, Q> *')).toEqual({
      raw: 'Foo<P, Q> *',
      baseName: 'Foo',
      protocols: ['P', 'Q'],
      typeArguments: [],
      qualifiers: [],
      receiverForm: 'instance',
    });
  });

  it('keeps protocol-only id and Class receivers distinct', () => {
    expect(parseObjectiveCTypeDescriptor('id<StoreDelegate>')).toMatchObject({
      protocols: ['StoreDelegate'],
      receiverForm: 'instance',
    });
    expect(parseObjectiveCTypeDescriptor('Class<StoreDelegate>')).toMatchObject({
      protocols: ['StoreDelegate'],
      receiverForm: 'class-object',
    });
  });

  it('retains generic arguments and receiver qualifiers', () => {
    expect(parseObjectiveCTypeDescriptor('const NSArray<Foo *> * nonnull')).toMatchObject({
      baseName: 'NSArray',
      typeArguments: ['Foo *'],
      qualifiers: ['const', 'nonnull'],
      receiverForm: 'instance',
    });
  });

  it('fails closed for malformed type syntax', () => {
    expect(parseObjectiveCTypeDescriptor('NSObject<script')).toEqual({
      raw: 'NSObject<script',
      protocols: [],
      typeArguments: [],
      qualifiers: [],
      receiverForm: 'dynamic',
    });
  });
});
