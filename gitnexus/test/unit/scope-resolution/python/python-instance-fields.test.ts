import { describe, expect, it } from 'vitest';
import { getPythonParser } from '../../../../src/core/ingestion/languages/python/query.js';
import { extractPythonInstanceFields } from '../../../../src/core/ingestion/languages/python/instance-fields.js';

describe('Python constructor field declarations', () => {
  it.each([
    {
      name: 'unannotated value',
      body: 'def __init__(self):\n    self.value = 1',
      fields: ['value'],
    },
    {
      name: 'alternate receiver',
      body: 'def __init__(this):\n    this.value = 1',
      fields: ['value'],
    },
    {
      name: 'tuple targets',
      body: 'def __init__(self):\n    self.x, self.y = (1, 2)',
      fields: ['x', 'y'],
    },
    {
      name: 'conditional assignment',
      body: 'def __init__(self, flag):\n    if flag:\n        self.value = 1',
      fields: ['value'],
    },
    {
      name: 'repeated assignment',
      body: 'def __init__(self):\n    self.value = 1\n    self.value = 2',
      fields: ['value'],
    },
    {
      name: 'later constructor replaces the earlier definition',
      body: 'def __init__(self):\n    self.stale = 1\ndef __init__(self):\n    self.live = 2',
      fields: ['live'],
    },
    {
      name: 'later static constructor replaces the earlier instance method',
      body: 'def __init__(self):\n    self.stale = 1\n@staticmethod\ndef __init__():\n    pass',
      fields: [],
    },
    {
      name: 'conditional replacement leaves constructor ownership uncertain',
      body: 'def __init__(self):\n    self.stale = 1\nif flag:\n    def __init__(self):\n        self.possible = 2',
      fields: [],
    },
    {
      name: 'unconditional constructor replaces earlier conditional definitions',
      body: 'if flag:\n    def __init__(self):\n        self.stale = 1\ndef __init__(self):\n    self.live = 2',
      fields: ['live'],
    },
    {
      name: 'class declaration already owns the field',
      body: 'value: int\ndef __init__(self):\n    self.value = 1',
      fields: [],
    },
    {
      name: 'property setter already owns the attribute',
      body: '@property\ndef value(self):\n    return 1\n@value.setter\ndef value(self, value):\n    pass\ndef __init__(self):\n    self.value = 1',
      fields: [],
    },
    {
      name: 'annotation without assignment',
      body: 'def __init__(self):\n    self.value: int',
      fields: [],
    },
    {
      name: 'foreign receiver',
      body: 'def __init__(self, other):\n    other.value = 1',
      fields: [],
    },
    {
      name: 'nested function',
      body: 'def __init__(self):\n    def nested():\n        self.value = 1',
      fields: [],
    },
    {
      name: 'static method',
      body: '@staticmethod\ndef __init__(self):\n    self.value = 1',
      fields: [],
    },
    {
      name: 'class method',
      body: '@classmethod\ndef __init__(cls):\n    cls.value = 1',
      fields: [],
    },
    {
      name: 'unknown decorator',
      body: '@wrapper\ndef __init__(self):\n    self.value = 1',
      fields: [],
    },
    {
      name: 'rebound receiver',
      body: 'def __init__(self, other):\n    self = other\n    self.value = 1',
      fields: [],
    },
    {
      name: 'loop target rebinds receiver',
      body: 'def __init__(self, items):\n    for self, x in items:\n        self.value = 1',
      fields: [],
    },
    {
      name: 'context manager rebinds receiver',
      body: 'def __init__(self):\n    with ctx() as self:\n        self.value = 1',
      fields: [],
    },
  ])('$name', ({ body, fields }) => {
    const source = `class Model:\n${body
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n')}\n`;
    const owner = getPythonParser().parse(source).rootNode.firstNamedChild!;
    const extracted = extractPythonInstanceFields(owner, { filePath: 'model.py' });
    expect(extracted.map((field) => field.name).sort()).toEqual(fields);
  });

  it('retains source location, visibility, and explicit type evidence', () => {
    const owner = getPythonParser().parse(`class Model:
    def __init__(self):
        self._values: list[str] = []
`).rootNode.firstNamedChild!;
    expect(extractPythonInstanceFields(owner, { filePath: 'model.py' })).toEqual([
      expect.objectContaining({
        name: '_values',
        rawDeclaredType: 'list[str]',
        visibility: 'protected',
        sourceFile: 'model.py',
        line: 3,
        column: 13,
        isStatic: false,
      }),
    ]);
  });
});
