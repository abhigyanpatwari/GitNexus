/**
 * Unit Tests: Body schema source/container classification (#39)
 *
 * When `document-endpoint` documented a `Map<String, Object>` response body,
 * the source was reported as `primitive` even though the schema is a
 * container. That contradiction (source: 'primitive' + isContainer: true)
 * is misleading — downstream consumers reading the source field would treat
 * the response as a scalar and miss that it is a key-value container.
 *
 * Root cause: `resolveTypeSchema` spread the inner type's `source` verbatim
 * when wrapping it in a known collection type. For `Map<String, Object>`,
 * the inner is `Object`, which is in `SKIP_SCHEMA_TYPES` and resolves to
 * `source: 'primitive'`. The spread clobbered the outer container status.
 *
 * Fix: the outer source is now set explicitly to `'container'` (a new
 * variant) for all known collection wrappers. The Map/List/etc. handling
 * in `bodySchemaToJsonExample` and `bodySchemaToOpenAPISchema` honors it.
 */

import { describe, it, expect } from 'vitest';
import { bodySchemaToJsonExample, type BodySchema } from '../../src/mcp/local/document-endpoint.js';

describe('BodySchema source classification (#39)', () => {
  describe('bodySchemaToJsonExample', () => {
    it('returns a Map-shaped example for source: "container" with a Map type', () => {
      // (#39) `Map<String, Object>` should yield a non-null example
      // that signals "this is a map" rather than a primitive. The
      // previous behavior returned `null` because source was
      // 'primitive' and the function exited early.
      const schema: BodySchema = {
        typeName: 'Map<String, Object>',
        source: 'container',
        isContainer: true,
      };

      const example = bodySchemaToJsonExample(schema);

      expect(example).not.toBeNull();
      // A Map example is an object with a _type marker and an empty
      // _example object — visible in the generated docs as a "map
      // placeholder" rather than a missing body.
      expect(example).toHaveProperty('_type', 'Map<String, Object>');
      expect(example).toHaveProperty('_example');
    });

    it('returns a List-shaped example for source: "container" with a List type', () => {
      // (#39) A List wrapper has the same wrapping concern — a
      // `List<String>` returning null because the inner String is a
      // primitive would be wrong.
      const schema: BodySchema = {
        typeName: 'List<String>',
        source: 'container',
        isContainer: true,
      };

      const example = bodySchemaToJsonExample(schema);

      expect(example).not.toBeNull();
      // Lists are emitted as a single-element array of an empty object
      // — distinct from the Map placeholder, so the doc generator can
      // render a list vs. a map differently.
      expect(Array.isArray(example)).toBe(true);
    });

    it('returns null for source: "primitive" (unchanged behavior)', () => {
      // Backward compatibility: a plain primitive should still return
      // null. The new 'container' source does not change this path.
      const schema: BodySchema = {
        typeName: 'String',
        source: 'primitive',
      };

      expect(bodySchemaToJsonExample(schema)).toBeNull();
    });

    it('returns a placeholder for source: "external" (unchanged behavior)', () => {
      const schema: BodySchema = {
        typeName: 'com.example.ExternalType',
        source: 'external',
      };

      const example = bodySchemaToJsonExample(schema);

      expect(example).toEqual({ _type: 'com.example.ExternalType' });
    });

    it('generates a field-driven example for source: "indexed" with fields', () => {
      // Sanity: indexed schemas with fields still produce a proper
      // example. The container branch must not interfere.
      const schema: BodySchema = {
        typeName: 'UserDto',
        source: 'indexed',
        fields: [
          { name: 'id', type: 'Long', annotations: [] },
          { name: 'name', type: 'String', annotations: [] },
        ],
      };

      const example = bodySchemaToJsonExample(schema);

      expect(example).toMatchObject({
        id: expect.anything(),
        name: expect.anything(),
      });
    });
  });
});
