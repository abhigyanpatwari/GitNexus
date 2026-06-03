/**
 * Schema Builder - Convert BodySchema to OpenAPI Schema Object
 */

import type { OpenAPISchema } from './types.js';
import { PRIMITIVE_TYPES, SKIP_SCHEMA_TYPES, extractGenericInnerType } from '../ingestion/type-extractors/shared.js';

/** Field element with optional nested support (from embedNestedSchemas) */
export interface BodySchemaField {
  name: string;
  type: string;
  annotations: string[];
  source?: 'indexed' | 'external' | 'primitive' | 'container';
  fields?: BodySchemaField[];
  isContainer?: boolean;
}

/** Source types from document-endpoint.ts */
export interface BodySchema {
  typeName: string;
  source: 'indexed' | 'external' | 'primitive' | 'container';
  fields?: BodySchemaField[];
  repoId?: string;
  isContainer?: boolean;
  _recursiveRef?: string;
}

export interface ValidationRule {
  field: string;
  type: string;
  required: boolean;
  rules: string;
  _context?: string[];
}

/** Map Java/primitive types to OpenAPI types */
const TYPE_MAP: Record<string, string> = {
  // Primitives
  string: 'string',
  String: 'string',
  char: 'string',
  Character: 'string',

  // Java wildcards
  '?': 'object',
  '*': 'object',

  // Numbers
  int: 'integer',
  Integer: 'integer',
  long: 'integer',
  Long: 'integer',
  short: 'integer',
  Short: 'integer',
  byte: 'integer',
  Byte: 'integer',
  float: 'number',
  Float: 'number',
  double: 'number',
  Double: 'number',
  BigDecimal: 'number',
  BigInteger: 'integer',
  number: 'number',
  Number: 'number',
  
  // Booleans
  boolean: 'boolean',
  Boolean: 'boolean',
  
  // Date/Time
  Date: 'string',
  LocalDate: 'string',
  LocalDateTime: 'string',
  ZonedDateTime: 'string',
  Instant: 'string',
  Timestamp: 'string',
  
  // Collections (used as hints)
  List: 'array',
  Set: 'array',
  Collection: 'array',
  Array: 'array',
  Map: 'object',
  HashMap: 'object',
  Optional: 'object',
  Object: 'object',
  void: 'object',
  Void: 'object',
};

/** Map validation annotations to OpenAPI constraints */
const ANNOTATION_CONSTRAINTS: Record<string, (schema: OpenAPISchema, value?: string) => void> = {
  '@NotNull': (s) => { if (s.type === 'string') s.minLength = 1; },
  '@NotEmpty': (s) => { if (s.type === 'string') s.minLength = 1; },
  '@NotBlank': (s) => { if (s.type === 'string') s.minLength = 1; },
  '@Size': (s, value) => {
    const match = value?.match(/max\s*=\s*(\d+)/);
    if (match) s.maxLength = parseInt(match[1], 10);
  },
  '@Max': (s, value) => {
    const match = value?.match(/(\d+)/);
    if (match) s.maximum = parseInt(match[1], 10);
  },
  '@Min': (s, value) => {
    const match = value?.match(/(\d+)/);
    if (match) s.minimum = parseInt(match[1], 10);
  },
  '@Pattern': (s, value) => {
    const match = value?.match(/regexp\s*=\s*"([^"]+)"/);
    if (match) s.pattern = match[1];
  },
  '@Email': (s) => { s.format = 'email'; },
  '@Past': (_s) => { /* No direct OpenAPI mapping */ },
  '@Future': (_s) => { /* No direct OpenAPI mapping */ },
};

/**
 * Map a type string to OpenAPI type
 */
export function mapType(type: string): string {
  // Handle generic types like List<User>, Map<String, String>
  const baseType = type.split('<')[0].trim();
  
  // Check direct mapping
  if (TYPE_MAP[baseType]) {
    return TYPE_MAP[baseType];
  }
  
  // Check lowercase version
  const lowerType = baseType.toLowerCase();
  if (TYPE_MAP[lowerType]) {
    return TYPE_MAP[lowerType];
  }
  
  // Unknown types: uppercase first char suggests a DTO/class → 'object', otherwise 'string'
  const baseForCheck = type.split('<')[0].trim();
  if (baseForCheck[0] === baseForCheck[0].toUpperCase() && baseForCheck[0] !== baseForCheck[0].toLowerCase()) {
    return 'object';
  }
  return 'string';
}

/**
 * Extract format from type string and field name
 */
function extractFormat(type: string, fieldName?: string): string | undefined {
  const baseType = type.split('<')[0].trim();

  const FORMAT_MAP: Record<string, string> = {
    Date: 'date-time',
    LocalDate: 'date',
    LocalDateTime: 'date-time',
    ZonedDateTime: 'date-time',
    Instant: 'date-time',
    Timestamp: 'date-time',
    email: 'email',
    Email: 'email',
    uuid: 'uuid',
    UUID: 'uuid',
    uri: 'uri',
    URI: 'uri',
  };

  const typeFormat = FORMAT_MAP[baseType];
  if (typeFormat) return typeFormat;

  // Field-name heuristic: fields ending in Time/At/Timestamp → date-time
  if (fieldName) {
    const lower = fieldName.toLowerCase();
    if (lower.endsWith('time') || lower.endsWith('at') || lower.endsWith('timestamp')) {
      return 'date-time';
    }
  }

  return undefined;
}

/**
 * Apply validation annotations to schema
 */
function applyAnnotations(schema: OpenAPISchema, annotations: string[]): void {
  for (const annotation of annotations) {
    const match = annotation.match(/(@\w+)(?:\((.*)\))?/);
    if (!match) continue;

    const [, name, value] = match;
    const constraint = ANNOTATION_CONSTRAINTS[name];
    if (constraint) {
      constraint(schema, value);
    }
  }
}

/**
 * Check if a type string represents a collection type
 */
function isCollectionType(type: string): boolean {
  const collectionPatterns = ['List<', 'Set<', 'Collection<', 'ArrayList<', 'HashSet<'];
  return collectionPatterns.some(p => type.includes(p));
}

/**
 * Convert BodySchema to OpenAPI Schema Object
 */
export function bodySchemaToOpenAPISchema(schema: BodySchema | null | undefined): OpenAPISchema {
  if (!schema) {
    return {};
  }

  // Recursive type — emit $ref instead of expanding to prevent infinite recursion
  if (schema._recursiveRef) {
    return { $ref: `#/${schema._recursiveRef}` };
  }

  if (schema.isContainer) {
    // Map<K, V> types → object with additionalProperties
    const baseType = schema.typeName.split('<')[0].trim();
    if (baseType === 'Map' || baseType === 'HashMap' || baseType === 'LinkedHashMap' || baseType === 'TreeMap') {
      // Map<K, V> → { type: 'object', additionalProperties: { type: <V> } }
      const match = schema.typeName.match(/<(.+)>/);
      const inner = match ? match[1].trim() : 'Object';
      // For Map<K, V>, extract the value type (last type argument)
      let valueType = inner;
      let depth = 0;
      let lastComma = -1;
      for (let i = 0; i < inner.length; i++) {
        if (inner[i] === '<') depth++;
        else if (inner[i] === '>') depth--;
        else if (inner[i] === ',' && depth === 0) lastComma = i;
      }
      if (lastComma !== -1) {
        valueType = inner.slice(lastComma + 1).trim();
      }
      // Normalize Java wildcards to Object
      if (valueType === '?' || valueType === '*') valueType = 'Object';
      // If the value type is a generic container (e.g., List<String>), recursively resolve it
      const valueBaseType = valueType.split('<')[0].trim();
      if (valueBaseType === 'List' || valueBaseType === 'Set' || valueBaseType === 'ArrayList' ||
          valueBaseType === 'LinkedList' || valueBaseType === 'HashSet' || valueBaseType === 'TreeSet' ||
          valueBaseType === 'Collection' || valueBaseType === 'Iterable') {
        // Recursively resolve the container value type
        const valueSchema = bodySchemaToOpenAPISchema({
          typeName: valueType,
          source: schema.source,
          fields: schema.fields,
          isContainer: true,
        });
        return {
          type: 'object',
          additionalProperties: valueSchema,
        };
      }
      return {
        type: 'object',
        additionalProperties: {
          type: mapType(valueType),
        },
      };
    }

    // List<T>, Set<T> etc → array
    const innerType = extractGenericInnerType(schema.typeName) || 'object';

    // If the inner type was resolved with fields, use them instead of mapType
    if (schema.fields && schema.fields.length > 0) {
      const itemsSchema = bodySchemaToOpenAPISchema({
        typeName: innerType,
        source: schema.source,
        fields: schema.fields,
      });
      return { type: 'array', items: itemsSchema };
    }

    return {
      type: 'array',
      items: {
        type: mapType(innerType),
      },
    };
  }

  if (schema.source === 'primitive' || !schema.fields) {
    const type = mapType(schema.typeName);
    const openApiSchema: OpenAPISchema = { type };

    const format = extractFormat(schema.typeName);
    if (format) {
      openApiSchema.format = format;
    }

    return openApiSchema;
  }

  const properties: Record<string, OpenAPISchema> = {};
  const required: string[] = [];

  // Filter out serialVersionUID and process fields
  const filteredFields = schema.fields.filter(f => f.name !== 'serialVersionUID');

  for (const field of filteredFields) {
    // Check for embedded nested type (from embedNestedSchemas)
    if ('fields' in field && Array.isArray(field.fields)) {
      const nestedBodySchema: BodySchema = {
        typeName: field.type,
        source: field.source ?? 'indexed',
        fields: field.fields,
        isContainer: field.isContainer,
      };
      let fieldSchema = bodySchemaToOpenAPISchema(nestedBodySchema); // recursive call

      // Apply annotations from parent field
      if (field.annotations?.length > 0) {
        applyAnnotations(fieldSchema, field.annotations);
      }

      // Handle container wrapper (List<X> → array)
      if (field.isContainer || isCollectionType(field.type)) {
        fieldSchema = { type: 'array', items: fieldSchema };
      }
      properties[field.name] = fieldSchema;
      continue; // skip default primitive handling
    }

    const fieldType = mapType(field.type);
    const fieldSchema: OpenAPISchema = { type: fieldType };

    const format = extractFormat(field.type, field.name);
    if (format) {
      fieldSchema.format = format;
    }

    if (field.annotations?.length > 0) {
      applyAnnotations(fieldSchema, field.annotations);
    }

    const isRequired = field.annotations?.some(a =>
      a.includes('@NotNull') ||
      a.includes('@NotEmpty') ||
      a.includes('@NotBlank')
    ) ?? false;

    if (isRequired) {
      required.push(field.name);
    }
    
    properties[field.name] = fieldSchema;
  }
  
  const result: OpenAPISchema = {
    type: 'object',
    properties,
  };
  
  if (required.length > 0) {
    result.required = required;
  }
  
  return result;
}

/**
 * Convert a validation rule to OpenAPI schema constraints
 */
export function validationRuleToConstraints(rule: ValidationRule): OpenAPISchema {
  const schema: OpenAPISchema = {
    type: mapType(rule.type),
  };
  
  // Apply rules string (contains annotation info)
  if (rule.rules) {
    // Parse rules string for constraints
    applyAnnotations(schema, rule.rules.split(',').map(r => r.trim()));
  }
  
  if (rule.required) {
    // Mark as required in parent schema, not here
  }
  
  return schema;
}

/**
 * Create a schema reference
 */
export function createSchemaRef(schemaName: string): OpenAPISchema {
  return {
    $ref: `#/components/schemas/${schemaName}`,
  };
}

/**
 * Generate a valid schema name from type name
 */
export function generateSchemaName(typeName: string): string {
  // Remove generic parameters but keep inner type name
  // List<User> -> ListUser, Map<String, Object> -> MapStringObject
  const cleaned = typeName
    .replace(/[<>]/g, '')  // Remove angle brackets but keep inner type
    .replace(/[, ]/g, '')   // Remove commas and spaces
    .replace(/[^\w]/g, '')  // Remove other non-word chars
    .replace(/^(\d)/, '_$1'); // Prefix leading digits with underscore
  
  return cleaned || 'UnknownType';
}

/**
 * Check if a schema should be extracted to components
 */
export function shouldExtractToComponents(schema: BodySchema): boolean {
  // Must have fields and be from an indexed source
  if (schema.source !== 'indexed' || !schema.fields || schema.fields.length === 0) {
    return false;
  }
  // Non-container types: extract directly
  if (!schema.isContainer) return true;
  // Container types: extract if inner type is a named DTO (not primitive/container)
  const innerType = extractGenericInnerType(schema.typeName);
  if (innerType && !PRIMITIVE_TYPES.has(innerType) && !SKIP_SCHEMA_TYPES.has(innerType)) {
    return true;
  }
  return false;
}