import { describe, it } from 'node:test';
import tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';
import rule from './no-inline-confidence.mjs';

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tsParser } });
const error = { messageId: 'useEdgeConfidence' };

tester.run('no-inline-confidence', rule, {
  valid: [
    'const edge = { confidence: EdgeConfidence.x };',
    'function emit(confidence: number = EdgeConfidence.x) {}',
    'const DEFAULT_CONFIDENCE = EdgeConfidence.x;',
    'const edge = { confidence: computed, weight: 0.85 };',
    'const CONFIDENCE_EPSILON = 0.001;',
    'const edge = { [confidence]: 0.85 };',
    'const edge = { [`${key}`]: 0.5 };',
    'const confidence = a ? EdgeConfidence.x : EdgeConfidence.y;',
  ],
  invalid: [
    { code: 'const edge = { confidence: 0.85 };', errors: [error] },
    { code: 'function emit(confidence: number = 0.85) {}', errors: [error] },
    { code: 'const DEFAULT_CONFIDENCE = 0.85;', errors: [error] },
    { code: "const edge = { ['confidence']: 0.85 };", errors: [error] },
    { code: 'const edge = { [`confidence`]: 0.5 };', errors: [error] },
    { code: 'class Edge { confidence = 0.85; }', errors: [error] },
    { code: 'edge.confidence = 0.85;', errors: [error] },
    { code: 'obj[`confidence`] = 0.5;', errors: [error] },
    { code: 'confidence = -0.85;', errors: [error] },
    { code: 'const confidence = a ? 1.0 : 0.85;', errors: [error, error] },
    { code: 'const e = { confidence: ok ? 1.0 : 0.7 };', errors: [error, error] },
    { code: 'const e = { confidence: c * 0.8 };', errors: [error] },
    { code: 'const e = { confidence: x ?? 0.5 };', errors: [error] },
    { code: 'const e = { confidence: 0.85 as number };', errors: [error] },
    { code: 'const confidence = (0.85 satisfies number)!;', errors: [error] },
  ],
});
