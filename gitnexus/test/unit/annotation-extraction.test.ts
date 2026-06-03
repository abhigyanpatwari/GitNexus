/**
 * Unit Tests: Annotation Extraction
 *
 * Tests the extractAnnotations function for Java/Kotlin source code.
 * Covers marker annotations, full annotations with arguments, and nested annotations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import Kotlin from 'tree-sitter-kotlin';

// Import the function to test
import { extractAnnotations } from '../../src/core/ingestion/annotation-extractor.js';

describe('extractAnnotations', () => {
  const parser = new Parser();

  describe('Java', () => {
    beforeEach(() => {
      parser.setLanguage(Java);
    });

    it('extracts marker annotation (@Transactional)', () => {
      const code = `
        @Transactional
        public void process() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0); // method_declaration

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@Transactional');
      expect(annotations[0].attrs).toBeUndefined();
    });

    it('extracts annotation with single argument (@GetMapping("/users"))', () => {
      const code = `
        @GetMapping("/users")
        public List<User> getUsers() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@GetMapping');
      expect(annotations[0].attrs).toEqual({ '0': '/users' });
    });

    it('extracts annotation with named arguments (@Transactional(readOnly = true))', () => {
      const code = `
        @Transactional(readOnly = true)
        public User getUser() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@Transactional');
      expect(annotations[0].attrs).toEqual({ readOnly: 'true' });
    });

    it('extracts annotation with multiple named arguments', () => {
      const code = `
        @Transactional(readOnly = true, timeout = 120)
        public void process() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@Transactional');
      expect(annotations[0].attrs).toEqual({ readOnly: 'true', timeout: '120' });
    });

    it('extracts @Retryable with nested @Backoff annotation', () => {
      const code = `
        @Retryable(maxAttempts = 3, backoff = @Backoff(delay = 1000))
        public void retryableOperation() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@Retryable');
      expect(annotations[0].attrs?.maxAttempts).toBe('3');
      expect(annotations[0].attrs?.backoff).toBe('@Backoff(delay=1000)');
    });

    it('extracts @RequestMapping with method argument', () => {
      const code = `
        @RequestMapping(value = "/api", method = RequestMethod.GET)
        public ResponseEntity<Void> handleRequest() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@RequestMapping');
      expect(annotations[0].attrs?.value).toBe('/api');
      expect(annotations[0].attrs?.method).toBe('RequestMethod.GET');
    });

    it('extracts multiple annotations on same method', () => {
      const code = `
        @Transactional
        @Retryable
        @Async
        public void multiAnnotated() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(3);
      expect(annotations.map(a => a.name)).toEqual(['@Transactional', '@Retryable', '@Async']);
    });

    it('extracts annotations on class declaration', () => {
      const code = `
        @Service
        @Transactional
        public class UserService {}
      `;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(classNode!);

      expect(annotations).toHaveLength(2);
      expect(annotations.map(a => a.name)).toEqual(['@Service', '@Transactional']);
    });

    it('handles @RestController annotation', () => {
      const code = `
        @RestController
        @RequestMapping("/api/users")
        public class UserController {}
      `;
      const tree = parser.parse(code);
      const classNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(classNode!);

      expect(annotations).toHaveLength(2);
      expect(annotations[0].name).toBe('@RestController');
      expect(annotations[1].name).toBe('@RequestMapping');
      expect(annotations[1].attrs).toEqual({ '0': '/api/users' });
    });

    it('extracts @Cacheable annotation', () => {
      const code = `
        @Cacheable(value = "users", key = "#id")
        public User findById(Long id) {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@Cacheable');
      expect(annotations[0].attrs?.value).toBe('users');
      expect(annotations[0].attrs?.key).toBe('#id');
    });

    it('extracts @Scheduled annotation with cron expression', () => {
      const code = `
        @Scheduled(cron = "0 0 12 * * ?")
        public void dailyTask() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@Scheduled');
      expect(annotations[0].attrs?.cron).toBe('0 0 12 * * ?');
    });

    it('extracts @PreAuthorize security annotation', () => {
      const code = `
        @PreAuthorize("hasRole('ADMIN')")
        public void adminOnly() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@PreAuthorize');
      expect(annotations[0].attrs).toEqual({ '0': "hasRole('ADMIN')" });
    });
  });

  // TODO(#55): deep Kotlin annotation assertions pending Kotlin annotation extractor fix.
  // Smoke-only — verifies the parser is wired and `extractAnnotations` doesn't throw on minimal input.
  describe('Kotlin (smoke — #55)', () => {
    beforeEach(() => {
      parser.setLanguage(Kotlin);
    });

    it('parses a minimal annotation sample without throwing', () => {
      const code = `@JvmInline value class Foo(val x: Int)`;
      const tree = parser.parse(code);
      const declNode = tree.rootNode.child(0);
      expect(() => extractAnnotations(declNode!)).not.toThrow();
    });

    // (#55) Kotlin annotation extraction is now wired up. The
    // extractor was previously Java-only — it expected an `identifier`
    // child directly under `annotation`, but Kotlin's tree-sitter grammar
    // wraps the name in `annotation > constructor_invocation >
    // user_type > type_identifier` and the args in
    // `constructor_invocation > value_arguments`. The extractor now
    // handles both shapes.
    describe('deep Kotlin annotation assertions', () => {
      it('extracts marker annotation (@Transactional)', () => {
        const code = `
          @Transactional
          fun process() {}
        `;
        const tree = parser.parse(code);
        const funcNode = tree.rootNode.child(0);

        const annotations = extractAnnotations(funcNode!);

        expect(annotations).toHaveLength(1);
        expect(annotations[0].name).toBe('@Transactional');
      });

      it('extracts annotation with argument (@GetMapping("/users"))', () => {
        const code = `
          @GetMapping("/users")
          fun getUsers(): List<User> {}
        `;
        const tree = parser.parse(code);
        const funcNode = tree.rootNode.child(0);

        const annotations = extractAnnotations(funcNode!);

        expect(annotations).toHaveLength(1);
        expect(annotations[0].name).toBe('@GetMapping');
        expect(annotations[0].attrs).toEqual({ '0': '/users' });
      });

      it('extracts @Transactional with named arguments', () => {
        const code = `
          @Transactional(readOnly = true)
          fun getUser(): User {}
        `;
        const tree = parser.parse(code);
        const funcNode = tree.rootNode.child(0);

        const annotations = extractAnnotations(funcNode!);

        expect(annotations).toHaveLength(1);
        expect(annotations[0].name).toBe('@Transactional');
        expect(annotations[0].attrs).toEqual({ readOnly: 'true' });
      });
    });
  });

  describe('Edge cases', () => {
    it('returns empty array for method without annotations', () => {
      parser.setLanguage(Java);
      const code = `public void noAnnotations() {}`;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(0);
    });

    it('returns empty array for null node', () => {
      const annotations = extractAnnotations(null as any);
      expect(annotations).toHaveLength(0);
    });

    it('handles array argument in annotation', () => {
      parser.setLanguage(Java);
      const code = `
        @RolesAllowed({"ADMIN", "MANAGER"})
        public void managed() {}
      `;
      const tree = parser.parse(code);
      const methodNode = tree.rootNode.child(0);

      const annotations = extractAnnotations(methodNode!);

      expect(annotations).toHaveLength(1);
      expect(annotations[0].name).toBe('@RolesAllowed');
      expect(annotations[0].attrs).toEqual({ '0': '[ADMIN, MANAGER]' });
    });
  });
});