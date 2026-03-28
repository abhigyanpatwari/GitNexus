import { describe, it, expect } from 'vitest';
import {
  calculateEntryPointScore,
  isTestFile,
  isUtilityFile,
} from '../../src/core/ingestion/entry-point-scoring.js';

describe('calculateEntryPointScore', () => {
  describe('base scoring', () => {
    it('returns 0 for functions with no outgoing calls', () => {
      const result = calculateEntryPointScore('handler', 'typescript', true, 0, 0);
      expect(result.score).toBe(0);
      expect(result.reasons).toContain('no-outgoing-calls');
    });

    it('calculates base score as calleeCount / (callerCount + 1)', () => {
      const result = calculateEntryPointScore('doStuff', 'typescript', false, 0, 5);
      // base = 5 / (0 + 1) = 5, no export bonus, no name bonus
      expect(result.score).toBe(5);
    });

    it('reduces score for functions with many callers', () => {
      const few = calculateEntryPointScore('doStuff', 'typescript', false, 1, 5);
      const many = calculateEntryPointScore('doStuff', 'typescript', false, 10, 5);
      expect(few.score).toBeGreaterThan(many.score);
    });
  });

  describe('export multiplier', () => {
    it('applies 2.0 multiplier for exported functions', () => {
      const exported = calculateEntryPointScore('doStuff', 'typescript', true, 0, 4);
      const notExported = calculateEntryPointScore('doStuff', 'typescript', false, 0, 4);
      expect(exported.score).toBe(notExported.score * 2);
      expect(exported.reasons).toContain('exported');
    });

    it('does not add exported reason when not exported', () => {
      const result = calculateEntryPointScore('doStuff', 'typescript', false, 0, 4);
      expect(result.reasons).not.toContain('exported');
    });
  });

  describe('universal name patterns', () => {
    it.each(['main', 'init', 'bootstrap', 'start', 'run', 'setup', 'configure'])(
      'recognizes "%s" as entry point pattern',
      (name) => {
        const result = calculateEntryPointScore(name, 'typescript', false, 0, 3);
        expect(result.reasons).toContain('entry-pattern');
      },
    );

    it.each([
      'handleLogin',
      'handleSubmit',
      'onClick',
      'onSubmit',
      'RequestHandler',
      'UserController',
      'processPayment',
      'executeQuery',
      'performAction',
      'dispatchEvent',
      'triggerAction',
      'fireEvent',
      'emitEvent',
    ])('recognizes "%s" as entry point pattern', (name) => {
      const result = calculateEntryPointScore(name, 'typescript', false, 0, 3);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('applies 1.5x name multiplier for entry patterns', () => {
      const matching = calculateEntryPointScore('handleLogin', 'typescript', false, 0, 4);
      const plain = calculateEntryPointScore('doStuff', 'typescript', false, 0, 4);
      // matching gets 1.5x, plain gets 1.0x
      expect(matching.score).toBe(plain.score * 1.5);
    });
  });

  describe('language-specific patterns', () => {
    it('recognizes React hooks for TypeScript', () => {
      const result = calculateEntryPointScore('useEffect', 'typescript', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes React hooks for JavaScript', () => {
      const result = calculateEntryPointScore('useState', 'javascript', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes Python REST patterns', () => {
      const result = calculateEntryPointScore('get_users', 'python', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes Java servlet patterns', () => {
      const result = calculateEntryPointScore('doGet', 'java', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes Go handler patterns', () => {
      const result = calculateEntryPointScore('NewServer', 'go', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes Rust entry patterns', () => {
      const result = calculateEntryPointScore('handle_request', 'rust', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes Swift UIKit lifecycle', () => {
      const result = calculateEntryPointScore('viewDidLoad', 'swift', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes Swift SwiftUI body', () => {
      const result = calculateEntryPointScore('body', 'swift', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes PHP Laravel patterns', () => {
      // __invoke starts with '_' which matches utility pattern first
      const result = calculateEntryPointScore('handle', 'php', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes PHP RESTful resource methods', () => {
      const result = calculateEntryPointScore('index', 'php', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes C# ASP.NET patterns', () => {
      const result = calculateEntryPointScore('GetUsers', 'csharp', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    it('recognizes C main entry point', () => {
      const result = calculateEntryPointScore('main', 'c', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    // C-specific patterns
    it.each([
      'init_server',
      'server_init',
      'start_server',
      'handle_request',
      'signal_handler',
      'event_callback',
      'cmd_new_window',
      'server_start',
      'client_connect',
      'session_create',
      'window_resize',
    ])('recognizes C pattern "%s"', (name) => {
      const result = calculateEntryPointScore(name, 'c', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });

    // C++-specific patterns
    it.each([
      'CreateInstance',
      'create_session',
      'Run',
      'run',
      'Start',
      'start',
      'OnEventReceived',
      'on_click',
    ])('recognizes C++ pattern "%s"', (name) => {
      const result = calculateEntryPointScore(name, 'cpp', false, 0, 2);
      expect(result.reasons).toContain('entry-pattern');
    });
  });

  describe('utility pattern penalty', () => {
    it.each([
      'getUser',
      'setName',
      'isValid',
      'hasPermission',
      'canEdit',
      'formatDate',
      'parseJSON',
      'validateInput',
      'toString',
      'fromJSON',
      'encodeBase64',
      'serializeData',
      'cloneDeep',
      'mergeObjects',
    ])('penalizes utility function "%s"', (name) => {
      const result = calculateEntryPointScore(name, 'typescript', false, 0, 3);
      expect(result.reasons).toContain('utility-pattern');
      // 0.3 multiplier
      const plain = calculateEntryPointScore('doStuff', 'typescript', false, 0, 3);
      expect(result.score).toBeLessThan(plain.score);
    });

    it('penalizes private-by-convention functions', () => {
      const result = calculateEntryPointScore('_internal', 'typescript', false, 0, 3);
      expect(result.reasons).toContain('utility-pattern');
    });
  });

  describe('framework detection from path', () => {
    it('boosts Next.js page entry points', () => {
      const result = calculateEntryPointScore(
        'render',
        'typescript',
        true,
        0,
        3,
        'pages/users.tsx',
      );
      expect(result.reasons.some((r) => r.includes('framework:'))).toBe(true);
      expect(result.score).toBeGreaterThan(0);
    });

    it('does not apply framework bonus for non-framework paths', () => {
      const result = calculateEntryPointScore(
        'render',
        'typescript',
        true,
        0,
        3,
        'src/lib/utils.ts',
      );
      expect(result.reasons.every((r) => !r.includes('framework:'))).toBe(true);
    });
  });

  describe('combined scoring', () => {
    it('multiplies all factors together', () => {
      // handleLogin: entry pattern (1.5x) + exported (2.0x) + base
      const result = calculateEntryPointScore(
        'handleLogin',
        'typescript',
        true,
        0,
        4,
        'routes/auth.ts',
      );
      expect(result.score).toBeGreaterThan(0);
      expect(result.reasons).toContain('exported');
      expect(result.reasons).toContain('entry-pattern');
    });
  });
});

describe('isTestFile', () => {
  it.each([
    'src/utils.test.ts',
    'src/utils.spec.ts',
    '__tests__/utils.ts',
    '__mocks__/api.ts',
    'src/test/integration/db.ts',
    'src/tests/unit/helper.ts',
    'src/testing/setup.ts',
    'lib/test_utils.py',
    'pkg/handler_test.go',
    'src/test/java/com/example/Test.java',
    'MyViewTests.swift',
    'MyViewTest.swift',
    'UITests/LoginTest.swift',
    'App.Tests/MyTest.cs',
    'tests/Feature/UserTest.php',
    'tests/Unit/AuthSpec.php',
  ])('returns true for test file "%s"', (filePath) => {
    expect(isTestFile(filePath)).toBe(true);
  });

  it.each([
    'src/utils.ts',
    'src/controllers/auth.ts',
    'src/main.py',
    'cmd/server.go',
    'src/main/java/App.java',
  ])('returns false for non-test file "%s"', (filePath) => {
    expect(isTestFile(filePath)).toBe(false);
  });

  it('normalizes Windows backslashes', () => {
    expect(isTestFile('src\\__tests__\\utils.ts')).toBe(true);
  });
});

describe('isUtilityFile', () => {
  it.each([
    'src/utils/format.ts',
    'src/util/helpers.ts',
    'src/helpers/date.ts',
    'src/helper/string.ts',
    'src/common/types.ts',
    'src/shared/constants.ts',
    'src/lib/crypto.ts',
    'src/utils.ts',
    'src/utils.js',
    'src/helpers.ts',
    'lib/date_utils.py',
    'lib/date_helpers.py',
  ])('returns true for utility file "%s"', (filePath) => {
    expect(isUtilityFile(filePath)).toBe(true);
  });

  it.each(['src/controllers/auth.ts', 'src/routes/api.ts', 'src/main.ts', 'src/app.ts'])(
    'returns false for non-utility file "%s"',
    (filePath) => {
      expect(isUtilityFile(filePath)).toBe(false);
    },
  );
});
