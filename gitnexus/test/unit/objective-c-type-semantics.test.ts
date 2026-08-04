import { describe, expect, it } from 'vitest';

import { parseObjectiveCTypeDescriptor } from '../../src/core/ingestion/languages/objective-c/type-semantics.js';

function expectDynamicDescriptor(raw: string): void {
  expect(parseObjectiveCTypeDescriptor(raw)).toEqual({
    raw,
    protocols: [],
    typeArguments: [],
    qualifiers: [],
    receiverForm: 'dynamic',
  });
}

function nestedArrayType(depth: number): string {
  return `${'NSArray<'.repeat(depth)}Worker *${'>'.repeat(depth)} *`;
}

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

  it('preserves bare id qualifiers while keeping the receiver dynamic', () => {
    expect(parseObjectiveCTypeDescriptor('id _Nullable')).toEqual({
      raw: 'id _Nullable',
      baseName: 'id',
      protocols: [],
      typeArguments: [],
      qualifiers: ['_Nullable'],
      receiverForm: 'dynamic',
    });
  });

  it('preserves bare Class qualifiers and class-object semantics', () => {
    expect(parseObjectiveCTypeDescriptor('Class _Nullable')).toEqual({
      raw: 'Class _Nullable',
      baseName: 'Class',
      protocols: [],
      typeArguments: [],
      qualifiers: ['_Nullable'],
      receiverForm: 'class-object',
    });
    expect(parseObjectiveCTypeDescriptor('Class')).toMatchObject({
      baseName: 'Class',
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

  it('retains nested lightweight generic arguments without flattening inner commas', () => {
    const raw =
      'NSDictionary<NSString *, NSArray<NSDictionary<NSString *, Worker *> *> *> * _Nullable';

    expect(parseObjectiveCTypeDescriptor(raw)).toEqual({
      raw,
      baseName: 'NSDictionary',
      protocols: [],
      typeArguments: ['NSString *', 'NSArray<NSDictionary<NSString *, Worker *> *> *'],
      qualifiers: ['_Nullable'],
      receiverForm: 'instance',
    });
  });

  it('accepts sixteen angle levels and fails closed above the nesting limit', () => {
    expect(parseObjectiveCTypeDescriptor(nestedArrayType(16))).toMatchObject({
      baseName: 'NSArray',
      receiverForm: 'instance',
    });
    expectDynamicDescriptor(nestedArrayType(17));
  });

  it('fails closed when a type declaration exceeds 4096 characters', () => {
    expectDynamicDescriptor('A'.repeat(4_097));
  });

  it.each([
    '_Nullable',
    '_Nonnull',
    '_Null_unspecified',
    '__nullable',
    '__nonnull',
    '__null_unspecified',
  ])('retains the Objective-C nullability qualifier %s', (qualifier) => {
    expect(parseObjectiveCTypeDescriptor(`Worker * ${qualifier}`)).toMatchObject({
      baseName: 'Worker',
      qualifiers: [qualifier],
      receiverForm: 'instance',
    });
  });

  it('accepts a Unicode concrete receiver name', () => {
    expect(parseObjectiveCTypeDescriptor('工作者 *')).toMatchObject({
      baseName: '工作者',
      protocols: [],
      receiverForm: 'instance',
    });
  });

  it('accepts Unicode protocol identifiers', () => {
    expect(parseObjectiveCTypeDescriptor('Worker<处理协议, 第二协议> *')).toMatchObject({
      baseName: 'Worker',
      protocols: ['处理协议', '第二协议'],
      receiverForm: 'instance',
    });
  });

  it.each([
    'NSArray<> *',
    'NSArray<Worker *,> *',
    'NSArray<, Worker *> *',
    'NSDictionary<NSString *,, Worker *> *',
    'NSObject<script',
    'NSArray<Worker *>> *',
  ])('fails closed for malformed type syntax: %j', (raw) => {
    expectDynamicDescriptor(raw);
  });
});
