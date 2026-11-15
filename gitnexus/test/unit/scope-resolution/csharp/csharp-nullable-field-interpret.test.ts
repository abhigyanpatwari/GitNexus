import { describe, expect, it } from 'vitest';
import type { Capture, CaptureMatch } from 'gitnexus-shared';
import { interpretCsharpTypeBinding } from '../../../../src/core/ingestion/languages/csharp/interpret.js';

const range = { startLine: 0, startCol: 0, endLine: 0, endCol: 0 } as const;
const capture = (name: string, text: string): Capture => ({ name, text, range });

function nullableField(type: string) {
  const captures: CaptureMatch = {
    '@type-binding.name': capture('@type-binding.name', 'field'),
    '@type-binding.type': capture('@type-binding.type', type),
    '@type-binding.annotation': capture('@type-binding.annotation', type),
    '@type-binding.nullable-field': capture('@type-binding.nullable-field', type),
  };
  return interpretCsharpTypeBinding(captures);
}

describe('nullable field outer qualification', () => {
  it.each([
    'List<User>',
    'List<Models.User>',
    'Dictionary<string, Models.User>',
    'List<Dictionary<string, Models.User>>',
    'Box<Models.Outer<int>.Inner<string>>',
    'List</* > */Models.User>',
    'List<// >\nModels.User>',
  ])('preserves the entire unqualified wrapper %s', (type) => {
    expect(nullableField(`${type}?`)).toEqual({
      boundName: 'field',
      rawTypeName: type,
      source: 'annotation',
    });
  });

  it.each([
    'Actual.User',
    'External.User',
    'Custom.List<User>',
    'Custom.List<Models.User>',
    'Outer<User>.Inner<Models.User>',
    'Outer<List<Models.User>>.Inner<User>',
    'Outer<User>.Values',
    'Outer</* < */User>.Inner<User>',
    'Outer<User>/* < */.Inner<User>',
    'Outer<User>// <\n.Inner<User>',
  ])('declines a qualified outer receiver %s', (type) => {
    expect(nullableField(`${type}?`)).toBeNull();
  });
});
