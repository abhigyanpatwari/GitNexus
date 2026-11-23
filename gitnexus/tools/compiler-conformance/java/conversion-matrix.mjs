import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Distinct class names even on case-insensitive filesystems (long vs Long).
const parameterTypes = {
  PrimitiveLong: 'long',
  BoxedInteger: 'Integer',
  BoxedLong: 'Long',
  Number: 'Number',
  Object: 'Object',
};
const argumentsToCheck = ['1', '1L', 'boxedInt', 'boxedLong', 'null'];

export function writeConversionMatrix(dir) {
  const expectedSites = new Set();
  const types = Object.entries(parameterTypes);
  for (const [firstName, firstType] of types) {
    for (const [secondName, secondType] of types) {
      if (firstType === secondType) continue;
      const className = `Pick_${firstName}_${secondName}`;
      const file = `${className}.java`;
      const lines = [
        `class ${className} {`,
        `    static void pick(${firstType} value) {}`,
        `    static void pick(${secondType} value) {}`,
        '    static void caller(Integer boxedInt, Long boxedLong) {',
      ];
      for (const argument of argumentsToCheck) {
        const indent = '        ';
        const call = `pick(${argument})`;
        const line = lines.push(`${indent}${call};`);
        expectedSites.add(
          `${file}:${line}:${indent.length}..${line}:${indent.length + call.length}`,
        );
      }
      lines.push('    }', '}', '');
      writeFileSync(path.join(dir, file), lines.join('\n'));
    }
  }
  return expectedSites;
}
