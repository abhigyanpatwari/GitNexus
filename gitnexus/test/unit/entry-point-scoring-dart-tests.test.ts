import { describe, expect, it } from 'vitest';
import { isTestFile } from '../../src/core/ingestion/entry-point-scoring.js';

describe('isTestFile Dart and repo-relative test paths', () => {
  it.each([
    'test/pages/dashboard_page_test.dart',
    'test/integration/helper.dart',
    'lib/widgets/profile_card_test.dart',
    'tests/process_flow.dart',
  ])('recognizes %s as test code', (filePath) => {
    expect(isTestFile(filePath)).toBe(true);
  });

  it('recognizes Windows-style repo-relative Dart test paths', () => {
    expect(isTestFile('test\\pages\\dashboard_page_test.dart')).toBe(true);
  });

  it.each(['lib/widgets/profile_card.dart', 'src/main.dart', 'src/testing_helpers.dart'])(
    'does not classify %s as test code',
    (filePath) => {
      expect(isTestFile(filePath)).toBe(false);
    },
  );
});
