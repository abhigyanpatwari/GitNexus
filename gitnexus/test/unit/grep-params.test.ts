/**
 * Unit Tests: /api/grep query parsing (gitnexus/src/server/grep-params.ts)
 *
 * Patch 12 contract fix — the grep tool schema promised regex +
 * fileFilter + caseSensitive, but the handler escaped every pattern into
 * a literal substring. These tests pin the restored semantics:
 *   - regex is real regex (alternation, classes, quantifiers work)
 *   - literal=1 keeps the old escaped-substring behaviour opt-in
 *   - fileFilter normalizes to a lowercase path substring
 *   - caseSensitive=1 drops the 'i' flag
 *   - malformed input throws BadRequestError (→ 400 via statusFromError)
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseGrepQuery,
  GREP_PATTERN_MAX_LENGTH,
  GREP_DEFAULT_LIMIT,
  GREP_MAX_LIMIT,
} from '../../src/server/grep-params.js';
import { BadRequestError } from '../../src/server/validation.js';

describe('parseGrepQuery — regex semantics (restored contract)', () => {
  it('honours alternation, the case the agent was burned by', () => {
    const { regex } = parseGrepQuery({ pattern: 'sign|Sign' });
    expect(regex.test('signOrder(order)')).toBe(true);
    expect(regex.test('SignOffOrderAfterDecorator')).toBe(true);
    expect(regex.test('assign a value')).toBe(true); // substring semantics, like grep
    expect(regex.test('unrelated line')).toBe(false);
  });

  it('supports the schema example "console\\.log" against real code lines', () => {
    const { regex } = parseGrepQuery({ pattern: 'console\\.log' });
    expect(regex.test('console.log("hi")')).toBe(true);
    expect(regex.test('consolexlog("hi")')).toBe(false);
  });

  it('is case-insensitive by default', () => {
    const { regex } = parseGrepQuery({ pattern: 'todo' });
    expect(regex.test('TODO: fix me')).toBe(true);
  });

  it('caseSensitive=1 drops the i flag', () => {
    const { regex } = parseGrepQuery({ pattern: 'todo', caseSensitive: '1' });
    expect(regex.test('TODO: fix me')).toBe(false);
    expect(regex.test('todo: fix me')).toBe(true);
  });

  it('caseSensitive=true is accepted alongside the bare flag form', () => {
    const { regex } = parseGrepQuery({ pattern: 'todo', caseSensitive: 'true' });
    expect(regex.test('TODO')).toBe(false);
  });

  it('literal=1 restores the old escaped-substring behaviour', () => {
    const literal = parseGrepQuery({ pattern: 'a.b', literal: '1' });
    expect(literal.regex.test('a.b')).toBe(true);
    expect(literal.regex.test('axb')).toBe(false);

    const regexMode = parseGrepQuery({ pattern: 'a.b' });
    expect(regexMode.regex.test('axb')).toBe(true);
  });

  it('matches CJK identifiers/comments (the primary consumer is a Chinese-codebase team)', () => {
    const { regex } = parseGrepQuery({ pattern: '签署|signOrder' });
    expect(regex.test('public void signOrder() { // 医嘱签署')).toBe(true);
    expect(regex.test('// 签署接口')).toBe(true);
    expect(regex.test('// 撤销接口')).toBe(false);
  });

  it('anchors ^/$ at line boundaries — the handler tests one line at a time, so "m" semantics are irrelevant', () => {
    const { regex } = parseGrepQuery({ pattern: '^import .*$' });
    expect(regex.test('import path from "path";')).toBe(true);
    expect(regex.test('  import path from "path";')).toBe(false);
  });
});

describe('parseGrepQuery — fileFilter', () => {
  it('normalizes to a lowercase path substring', () => {
    const { fileFilter } = parseGrepQuery({ pattern: 'x', fileFilter: 'Controller.JAVA' });
    expect(fileFilter).toBe('controller.java');
  });

  it('empty / missing fileFilter disables path filtering', () => {
    expect(parseGrepQuery({ pattern: 'x' }).fileFilter).toBe('');
    expect(parseGrepQuery({ pattern: 'x', fileFilter: '' }).fileFilter).toBe('');
  });

  it('array-form fileFilter is type-confusion-rejected, not partially read', () => {
    expect(() => parseGrepQuery({ pattern: 'x', fileFilter: ['a', 'b'] })).toThrow(BadRequestError);
  });
});

describe('parseGrepQuery — limit clamping', () => {
  it('clamps above the max', () => {
    expect(parseGrepQuery({ pattern: 'x', limit: '5000' }).limit).toBe(GREP_MAX_LIMIT);
  });

  it('clamps below 1', () => {
    expect(parseGrepQuery({ pattern: 'x', limit: '-5' }).limit).toBe(1);
  });

  it('falls back to the default on non-numeric input', () => {
    expect(parseGrepQuery({ pattern: 'x', limit: 'abc' }).limit).toBe(GREP_DEFAULT_LIMIT);
  });

  it('defaults when absent', () => {
    expect(parseGrepQuery({ pattern: 'x' }).limit).toBe(GREP_DEFAULT_LIMIT);
  });
});

describe('parseGrepQuery — error paths (→ 400 via statusFromError)', () => {
  it('rejects a missing pattern', () => {
    expect(() => parseGrepQuery({})).toThrow(BadRequestError);
    expect(() => parseGrepQuery({ pattern: '' })).toThrow(BadRequestError);
  });

  it('rejects array-form patterns (type-confusion guard unchanged)', () => {
    try {
      parseGrepQuery({ pattern: ['a', 'b'] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).status).toBe(400);
      expect((err as Error).message).toContain('pattern');
    }
  });

  it('rejects over-long patterns at the same 200-char cap', () => {
    const long = 'a'.repeat(GREP_PATTERN_MAX_LENGTH + 1);
    expect(() => parseGrepQuery({ pattern: long })).toThrow(/max 200 characters/);
    expect(() => parseGrepQuery({ pattern: 'a'.repeat(GREP_PATTERN_MAX_LENGTH) })).not.toThrow();
  });

  it('rejects syntactically invalid regex', () => {
    expect(() => parseGrepQuery({ pattern: '((' })).toThrow(/Invalid regex/);
  });
});

describe('/api/grep handler wiring (source-level, api-readonly-wiring.test.ts style)', () => {
  const readSource = async () => fs.readFile(SRC_PATH, 'utf-8');
  const SRC_PATH = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/server/api.ts',
  );

  it('threaded through: parseGrepQuery call, worker scan, fileFilter filter, timedOut flag', async () => {
    const source = await readSource();
    const grepSection = source.match(/app\.get\('\/api\/grep'[\s\S]*?\n  \}\);/);
    expect(grepSection).not.toBeNull();
    const section = grepSection![0];
    expect(section).toContain('parseGrepQuery(');
    expect(section).toContain('GREP_TIME_BUDGET_MS');
    expect(section).toContain('runGrepScanInWorker(');
    expect(section).toMatch(/filePath\.toLowerCase\(\)\.includes\(fileFilter\)/);
    expect(section).toContain('timedOut: true');
    expect(section).toContain('readOnly: true'); // unchanged read-only DB open
  });
});
