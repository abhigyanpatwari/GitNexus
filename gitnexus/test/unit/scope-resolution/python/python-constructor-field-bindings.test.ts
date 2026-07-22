import { describe, expect, it } from 'vitest';
import type { CaptureMatch } from 'gitnexus-shared';
import {
  emitPythonScopeCaptures,
  interpretPythonTypeBinding,
} from '../../../../src/core/ingestion/languages/python/index.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { pythonProvider } from '../../../../src/core/ingestion/languages/python.js';

function constructorFieldBindings(source: string): CaptureMatch[] {
  return emitPythonScopeCaptures(source, 'fixture.py').filter(
    (match) => match['@type-binding.instance-field'] !== undefined,
  );
}

function interpretedBindings(source: string): Array<{
  boundName: string;
  rawTypeName: string;
  source: string;
}> {
  return constructorFieldBindings(source).map((match) => {
    const binding = interpretPythonTypeBinding(match);
    expect(binding).not.toBeNull();
    return binding!;
  });
}

describe('Python constructor field type bindings', () => {
  it.each([
    {
      name: 'annotated constructor parameter',
      source: `
class Facade:
    def __init__(self, service: Service):
        self.service = service
`,
    },
    {
      name: 'typed default parameter with a nullable forward reference',
      source: `
class Facade:
    def __init__(self, service: "Service | None" = None):
        self.service = service
`,
    },
    {
      name: 'explicit field annotation',
      source: `
class Facade:
    def __init__(self, service):
        self.service: Service = service
`,
    },
    {
      name: 'custom receiver name',
      source: `
class Facade:
    def __init__(this, service: Service):
        this.service = service
`,
    },
  ])('synthesizes an annotation-strength class field for $name', ({ source }) => {
    expect(interpretedBindings(source)).toEqual([
      { boundName: 'service', rawTypeName: 'Service', source: 'annotation' },
    ]);
  });

  it.each([
    {
      name: 'an unannotated constructor parameter',
      source: `
class Facade:
    def __init__(self, service):
        self.service = service
`,
    },
    {
      name: 'an assignment on a different receiver',
      source: `
class Facade:
    def __init__(self, service: Service):
        other.service = service
`,
    },
    {
      name: 'a non-constructor method',
      source: `
class Facade:
    def configure(self, service: Service):
        self.service = service
`,
    },
    {
      name: 'a static constructor-shaped method',
      source: `
class Facade:
    @staticmethod
    def __init__(self, service: Service):
        self.service = service
`,
    },
    {
      name: 'an annotation inside a nested function',
      source: `
class Facade:
    def __init__(self, value):
        def configure():
            self.service: Service = value
`,
    },
    {
      name: 'an annotation inside a nested class',
      source: `
class Facade:
    def __init__(self, value):
        class Nested:
            self.service: Service = value
`,
    },
  ])('does not synthesize a binding for $name', ({ source }) => {
    expect(constructorFieldBindings(source)).toEqual([]);
  });

  it('prefers an explicit field annotation over the parameter annotation', () => {
    const source = `
class Facade:
    def __init__(self, service: Protocol):
        self.service: ConcreteService = service
`;

    expect(interpretedBindings(source)).toEqual([
      { boundName: 'service', rawTypeName: 'ConcreteService', source: 'annotation' },
    ]);
  });

  it('hoists only the synthesized field binding to the enclosing class scope', () => {
    const parsed = extractParsedFile(
      pythonProvider,
      `
class Facade:
    def __init__(self, service: Service):
        self.service = service
`,
      'fixture.py',
    );
    expect(parsed).toBeDefined();

    const classScope = parsed!.scopes.find((scope) => scope.kind === 'Class');
    const constructorScope = parsed!.scopes.find((scope) => scope.kind === 'Function');
    expect(classScope?.typeBindings.get('service')).toMatchObject({
      rawName: 'Service',
      source: 'annotation',
    });
    expect(constructorScope?.typeBindings.get('service')).toMatchObject({
      rawName: 'Service',
      source: 'parameter-annotation',
    });
  });

  it('is deterministic across repeated capture runs', () => {
    const source = `
class Facade:
    def __init__(self, service: Service):
        self.service = service
`;

    expect(constructorFieldBindings(source)).toEqual(constructorFieldBindings(source));
  });
});
