import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from '../../../../src/config/supported-languages.js';
import { emitSwiftScopeCaptures } from '../../../../src/core/ingestion/languages/swift/captures.js';
import { collectSwiftOverloadLabels } from '../../../../src/core/ingestion/languages/swift/overload-labels.js';
import { getSwiftParser } from '../../../../src/core/ingestion/languages/swift/query.js';
import { isLanguageAvailable } from '../../../../src/core/tree-sitter/parser-loader.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

describe.skipIf(!swiftAvailable)('Swift overload-label capture with the vendored grammar', () => {
  it('captures direct parameter nodes with external names and unlabeled parameters', () => {
    const source = `
extension Handler {
    static func choose(input value: Int, _ count: Int) -> Int {
        func nested(other: Int) -> Int { other }
        return value + count
    }
}
`;
    const tree = getSwiftParser().parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const declaration = tree.rootNode.descendantsOfType('function_declaration')[0];
    const parameters = declaration.namedChildren.filter((node) => node.type === 'parameter');
    expect(parameters.map((node) => node.childForFieldName('external_name')?.text)).toEqual([
      'input',
      '_',
    ]);

    emitSwiftScopeCaptures(source, 'Parameters.swift', tree);
    const captured = collectSwiftOverloadLabels('Parameters.swift');
    const position = `${declaration.startPosition.row + 1}:${declaration.startPosition.column}`;
    expect(captured?.parametersByPosition[position]).toEqual(['input', '']);
  });

  it('captures the name field wrapping value_argument_label and survives serialization', () => {
    const source = `
extension Handler {
    static func run() {
        choose(input: 1)
        choose(other: 2)
        choose(3)
    }
}
`;
    const tree = getSwiftParser().parse(source);
    expect(tree.rootNode.hasError).toBe(false);
    const argumentsInSource = tree.rootNode.descendantsOfType('value_argument');
    const firstLabel = argumentsInSource[0].childForFieldName('name');
    expect(firstLabel?.type).toBe('value_argument_label');
    expect(firstLabel?.text).toBe('input');
    expect(argumentsInSource[2].childForFieldName('name')).toBeNull();

    emitSwiftScopeCaptures(source, 'Arguments.swift', tree);
    const captured = collectSwiftOverloadLabels('Arguments.swift');
    expect(captured).toBeDefined();
    const hydrated = JSON.parse(JSON.stringify(captured));
    expect(Object.values(hydrated.argumentsByPosition)).toEqual([['input'], ['other'], ['']]);
  });

  it('consumes each capture once and clears metadata for the next file', () => {
    emitSwiftScopeCaptures(
      'extension Handler { static func choose(input: Int) -> Int { input } }\n',
      'First.swift',
    );
    expect(collectSwiftOverloadLabels('First.swift')).toBeDefined();
    expect(collectSwiftOverloadLabels('First.swift')).toBeUndefined();

    emitSwiftScopeCaptures('struct Other {}\n', 'Second.swift');
    expect(collectSwiftOverloadLabels('Second.swift')).toBeUndefined();
  });
});
