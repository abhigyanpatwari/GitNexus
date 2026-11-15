import { describe, expect, it } from 'vitest';
import { emitRubyScopeCaptures } from '../../../../src/core/ingestion/languages/ruby/captures.js';
import { rubyBindingScopeFor } from '../../../../src/core/ingestion/languages/ruby/simple-hooks.js';
import { extract } from '../../../../src/core/ingestion/scope-extractor.js';

function parse(source: string) {
  const captures = emitRubyScopeCaptures(source, 'nested.rb');
  return {
    captures,
    file: extract(captures, 'nested.rb', { bindingScopeFor: rubyBindingScopeFor }),
  };
}

describe('Ruby nested method ownership', () => {
  it.each(['def target', 'def\n target', 'def # declaration comment\n target'])(
    'publishes an ordinary nested method with header %j at file scope',
    (header) => {
      const { file } = parse(`def boot\n  ${header}\n    :nested\n  end\nend\n`);
      const moduleScope = file.scopes.find((s) => s.kind === 'Module');
      expect(moduleScope?.bindings.get('target')).toHaveLength(1);
    },
  );

  it.each(['class', 'module'])(
    'publishes a nested declaration reclassified as Method on its enclosing %s',
    (keyword) => {
      const { captures, file } = parse(
        `${keyword} Host\n  def boot\n    def target\n      :nested\n    end\n  end\nend\n`,
      );
      const target = captures.find((c) => c['@declaration.name']?.text === 'target');
      expect(target?.['@declaration.method']).toBeDefined();
      const classScope = file.scopes.find((s) => s.kind === 'Class');
      expect(classScope?.bindings.get('target')).toHaveLength(1);
      const moduleScope = file.scopes.find((s) => s.kind === 'Module');
      expect(moduleScope?.bindings.has('target')).toBe(false);
    },
  );

  it.each(['def self.target', 'def target.target', 'def target::target'])(
    'does not publish singleton header %j as an ordinary method',
    (header) => {
      const { captures, file } = parse(`def boot\n  ${header}\n    :singleton\n  end\nend\n`);
      const target = captures.find((c) => c['@declaration.name']?.text === 'target');
      expect(target?.['@declaration.function']).toBeDefined();
      expect(target?.['@declaration.lexical-method']).toBeUndefined();
      const moduleScope = file.scopes.find((s) => s.kind === 'Module');
      expect(moduleScope?.bindings.has('target')).toBe(false);
    },
  );

  it.each(['-> { :value }', 'lambda { :value }', 'proc { :value }', 'Proc.new { :value }'])(
    'keeps the local closure %s inside its defining method',
    (expression) => {
      const { captures, file } = parse(`def boot\n  target = ${expression}\nend\n`);
      const target = captures.find(
        (c) =>
          c['@declaration.function'] !== undefined && c['@declaration.name']?.text === 'target',
      );
      expect(target).toBeDefined();
      expect(target?.['@declaration.lexical-method']).toBeUndefined();
      const moduleScope = file.scopes.find((s) => s.kind === 'Module');
      expect(moduleScope?.bindings.has('target')).toBe(false);
    },
  );

  it.each(['class << self', 'class << Other', 'def self.install'])(
    'does not project a nested def through singleton boundary %j',
    (boundary) => {
      const { captures, file } = parse(
        `class Host\n  ${boundary}\n    def boot\n      def target\n        :singleton\n      end\n    end\n  end\nend\n`,
      );
      const target = captures.find((c) => c['@declaration.name']?.text === 'target');
      expect(target?.['@declaration.method']).toBeDefined();
      expect(target?.['@declaration.lexical-method']).toBeUndefined();
      const classScope = file.scopes.find((s) => s.kind === 'Class');
      expect(classScope?.bindings.has('target')).toBe(false);
    },
  );

  it('does not project a def passed through a helper that can rebind the block definee', () => {
    const { file } = parse(`class Host
  def self.install(&body)
    Other.class_eval(&body)
  end
  install do
    def target
      :belongs_to_other
    end
  end
end
`);
    const classScope = file.scopes.find((s) => s.kind === 'Class');
    expect(classScope?.bindings.has('target')).toBe(false);
    const block = file.scopes.find((s) => s.kind === 'Block');
    expect(block?.bindings.get('target')).toHaveLength(1);
  });

  it('uses a class keyword inside an unknown block as a new lexical definee', () => {
    const { file } = parse(`helper do
  class Host
    def boot
      def target
        :belongs_to_host
      end
    end
  end
end
`);
    const classScope = file.scopes.find((s) => s.kind === 'Class');
    expect(classScope?.bindings.get('target')).toHaveLength(1);
  });
});
