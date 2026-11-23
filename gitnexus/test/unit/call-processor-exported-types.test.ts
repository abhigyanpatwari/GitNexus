import { describe, expect, it } from 'vitest';
import {
  accumulateExportedTypesFromParsedNode,
  type ExportedTypeMap,
} from '../../src/core/ingestion/call-processor.js';
import { createSemanticModel } from '../../src/core/ingestion/model/index.js';

const FILE = 'src/A.java';
const exported = (id: string) => ({
  id,
  properties: { isExported: true, filePath: FILE, name: 'save' },
});

describe('accumulateExportedTypesFromParsedNode', () => {
  it('types each same-named export from its own definition as the list grows', () => {
    const model = createSemanticModel();
    const result: ExportedTypeMap = new Map();
    const typeOf = (id: string): string | undefined => {
      accumulateExportedTypesFromParsedNode(result, exported(id), model.symbols);
      return result.get(FILE)?.get('save');
    };
    model.symbols.add(FILE, 'save', 'save:0', 'Function', { returnType: 'Zero' });
    model.symbols.add(FILE, 'save', 'save:1', 'Function', { returnType: 'One' });
    expect(typeOf('save:1')).toBe('One');
    model.symbols.add(FILE, 'save', 'save:2', 'Function', { returnType: 'Two' });
    model.symbols.add(FILE, 'save', 'save:1', 'Function', { returnType: 'Later' });
    // Found after the list grew; a repeated id keeps its first definition; an
    // unknown id falls back to the list's first definition.
    expect(typeOf('save:2')).toBe('Two');
    expect(typeOf('save:1')).toBe('One');
    expect(typeOf('save:9')).toBe('Zero');
  });
});
