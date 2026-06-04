/**
 * Ruby scope-resolution integration tests (U8).
 *
 * These tests exercise the scope-based resolution path. They validate
 * class methods, module mixins,
 * singleton methods, require_relative imports, constructor inference,
 * block scope, class inheritance, and super resolution.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

function writeFixtureRepo(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
}

// ---------------------------------------------------------------------------
// 1. Basic class method resolution
// ---------------------------------------------------------------------------

describe('Ruby scope: basic class method resolution', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-basic-'));
    writeFixtureRepo(tmpDir, {
      'models/user.rb': `
class User
  def save
    true
  end

  def greet
    "hello"
  end
end
`,
      'app.rb': `
require_relative 'models/user'

def main
  u = User.new
  u.save
  u.greet
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects User class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('detects save and greet as Method nodes', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('save');
    expect(methods).toContain('greet');
  });

  it('emits HAS_METHOD edges from User to save and greet', () => {
    const edges = getRelationships(result, 'HAS_METHOD');
    const userSave = edges.find((e) => e.source === 'User' && e.target === 'save');
    const userGreet = edges.find((e) => e.source === 'User' && e.target === 'greet');
    expect(userSave).toBeDefined();
    expect(userGreet).toBeDefined();
  });

  it('resolves main → u.save() as CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'main' && c.targetFilePath?.includes('user.rb'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Module mixin with include
// ---------------------------------------------------------------------------

describe('Ruby scope: module mixin with include', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-mixin-'));
    writeFixtureRepo(tmpDir, {
      'serializable.rb': `
module Serializable
  def serialize
    to_json
  end
end
`,
      'user.rb': `
require_relative 'serializable'

class User
  include Serializable

  def save
    serialize
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects User as Class and Serializable as Trait', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Trait')).toContain('Serializable');
  });

  it('emits IMPLEMENTS edge from User to Serializable', () => {
    const impls = getRelationships(result, 'IMPLEMENTS');
    const edge = impls.find((e) => e.source === 'User' && e.target === 'Serializable');
    expect(edge).toBeDefined();
  });

  it('resolves save → serialize as CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const serializeCall = calls.find((c) => c.target === 'serialize' && c.source === 'save');
    expect(serializeCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Singleton method (def self.foo)
// ---------------------------------------------------------------------------

describe('Ruby scope: singleton method (def self.foo)', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-singleton-'));
    writeFixtureRepo(tmpDir, {
      'config.rb': `
class Config
  def self.load
    new
  end

  def validate
    true
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Config class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Config');
  });

  it('detects load (singleton) and validate (instance) as Method nodes', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('load');
    expect(methods).toContain('validate');
  });

  it('emits HAS_METHOD edges from Config to both methods', () => {
    const edges = getRelationships(result, 'HAS_METHOD');
    const configLoad = edges.find((e) => e.source === 'Config' && e.target === 'load');
    const configValidate = edges.find((e) => e.source === 'Config' && e.target === 'validate');
    expect(configLoad).toBeDefined();
    expect(configValidate).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Require/require_relative import resolution
// ---------------------------------------------------------------------------

describe('Ruby scope: require_relative import resolution', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-imports-'));
    writeFixtureRepo(tmpDir, {
      'lib/utils.rb': `
class Utils
  def format(text)
    text.strip
  end
end
`,
      'app.rb': `
require_relative 'lib/utils'

def run
  u = Utils.new
  u.format("hello")
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits IMPORTS edge from app.rb to lib/utils.rb', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const imp = imports.find(
      (e) => e.sourceFilePath?.includes('app.rb') && e.targetFilePath?.includes('utils.rb'),
    );
    expect(imp).toBeDefined();
  });

  it('resolves run → u.format() as CALLS edge to utils.rb', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find(
      (c) => c.target === 'format' && c.source === 'run' && c.targetFilePath?.includes('utils.rb'),
    );
    expect(formatCall).toBeDefined();
  });

  it('detects Utils class and format method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Utils');
    expect(getNodesByLabel(result, 'Method')).toContain('format');
  });
});

// ---------------------------------------------------------------------------
// 5. Constructor inference (User.new)
// ---------------------------------------------------------------------------

describe('Ruby scope: constructor inference via .new', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-ctor-'));
    writeFixtureRepo(tmpDir, {
      'formatter.rb': `
class Formatter
  def format(text)
    text.upcase
  end
end

def main
  f = Formatter.new
  f.format("hello")
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Formatter class and format method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Formatter');
    expect(getNodesByLabel(result, 'Method')).toContain('format');
  });

  it('emits HAS_METHOD edge from Formatter to format', () => {
    const edges = getRelationships(result, 'HAS_METHOD');
    const fmtEdge = edges.find((e) => e.source === 'Formatter' && e.target === 'format');
    expect(fmtEdge).toBeDefined();
  });

  it('resolves main → f.format() to Formatter#format via constructor inference', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find(
      (c) =>
        c.target === 'format' && c.source === 'main' && c.targetFilePath?.includes('formatter.rb'),
    );
    expect(formatCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Block scope (do...end with params)
// ---------------------------------------------------------------------------

describe('Ruby scope: block scope with do...end', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-block-'));
    writeFixtureRepo(tmpDir, {
      'processor.rb': `
class Processor
  def run
    items = [1, 2, 3]
    items.each do |item|
      process(item)
    end
  end

  def process(x)
    x * 2
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Processor class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Processor');
  });

  it('detects run and process as Method nodes on Processor', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('run');
    expect(methods).toContain('process');
  });

  it('emits HAS_METHOD edges from Processor to run and process', () => {
    const edges = getRelationships(result, 'HAS_METHOD');
    const procRun = edges.find((e) => e.source === 'Processor' && e.target === 'run');
    const procProcess = edges.find((e) => e.source === 'Processor' && e.target === 'process');
    expect(procRun).toBeDefined();
    expect(procProcess).toBeDefined();
  });

  it('resolves run → process() as CALLS edge inside block scope', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCall = calls.find((c) => c.target === 'process' && c.source === 'run');
    expect(processCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Class inheritance (EXTENDS)
// ---------------------------------------------------------------------------

describe('Ruby scope: class inheritance via <', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-inherit-'));
    writeFixtureRepo(tmpDir, {
      'animals.rb': `
class Animal
  def speak
    "..."
  end
end

class Dog < Animal
  def bark
    speak
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Animal and Dog as Class nodes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Animal');
    expect(classes).toContain('Dog');
  });

  it('emits EXTENDS edge from Dog to Animal', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const edge = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(edge).toBeDefined();
  });

  it('resolves bark → speak as CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find((c) => c.target === 'speak' && c.source === 'bark');
    expect(speakCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Super resolution
// ---------------------------------------------------------------------------

describe('Ruby scope: super resolution in subclass', () => {
  let result: PipelineResult;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-scope-super-'));
    writeFixtureRepo(tmpDir, {
      'hierarchy.rb': `
class Base
  def greet
    "hello"
  end
end

class Child < Base
  def greet
    super
  end
end

def main
  c = Child.new
  c.greet
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Base and Child as Class nodes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('Base');
    expect(classes).toContain('Child');
  });

  it('emits EXTENDS edge from Child to Base', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const edge = extends_.find((e) => e.source === 'Child' && e.target === 'Base');
    expect(edge).toBeDefined();
  });

  it('resolves main → c.greet() as CALLS edge', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.source === 'main');
    expect(greetCall).toBeDefined();
  });
});
