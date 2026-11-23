/**
 * Ruby local-name claims: what an ordered claim for a local may and may not
 * change about the calls around it.
 *
 * A local claim exists so that a receiver naming an untyped local stops
 * borrowing an accessor's or an enclosing scope's type. These suites pin the
 * four places where that mechanism reached further than a local does in Ruby:
 * a second constructor assignment of one local, an explicit call that shares
 * its name with a local, a file whose first token opens a scope, and a heredoc
 * body, which Ruby reads at its opener. Every method name has two owners, so
 * no edge here can come from a unique-name guess.
 *
 * Each expected line is `<line>:<column> <target>`; a free-call edge keeps no
 * call site and prints `-`.
 */
import { describe, expect, it } from 'vitest';
import {
  lookupLexicalName,
  selectClaimsAtScope,
  type NameClaim,
  type Scope,
  type SymbolDefinition,
} from 'gitnexus-shared';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { emitRubyScopeCaptures } from '../../../src/core/ingestion/languages/ruby/captures.js';
import { getRelationships, useFixture } from './helpers.js';

/** Calls the fixtures make only to carry a value or a heredoc; never the subject. */
const PLUMBING: ReadonlySet<string> = new Set(['make', 'other', 'consume']);

/** `:line:col` after the target id when the edge id keeps the call site, else `-`. */
function siteOf(relationshipId: string, targetId: string): string {
  const suffix = relationshipId.slice(relationshipId.lastIndexOf(targetId) + targetId.length);
  const site = /^:(\d+):(\d+)/.exec(suffix);
  return site === null ? '-' : `${site[1]}:${site[2]}`;
}

/** The CALLS edges whose source node is named `source`, as `<site> <owner.method>`. */
function callsFrom(result: PipelineResult, source: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source && !PLUMBING.has(edge.target))
    .map((edge) => {
      const target = edge.rel.targetId.replace(/^[A-Za-z]+:[^:]+:/, '').replace(/#\d+$/, '');
      return `${siteOf(edge.rel.id, edge.rel.targetId)} ${target}`;
    })
    .sort();
}

const MODELS = `class Repo
  def save; end
  def load; end
end
class Other
  def save; end
  def load; end
end
`;

describe('Ruby local claims: a constructor fact reaches every read its assignment governs', () => {
  const run = useFixture('ruby-local-claims-facts', {
    'models.rb': MODELS,
    'script.rb': `require_relative 'models'
job = Repo.new
job.save
job = Repo.new
job.load
`,
    'svc.rb': `require_relative 'models'
class Svc
  def make; end

  def if_else(kind)
    if kind
      repo = Repo.new
      repo.save
    else
      repo = Repo.new
      repo.load
    end
    repo.load
  end

  def case_when(kind)
    case kind
    when :a
      repo = Repo.new
      repo.save
    when :b
      repo = Repo.new
      repo.load
    end
  end

  def retry_shape
    conn = Repo.new
    begin
      conn.save
    rescue StandardError
      conn = Repo.new
      retry
    end
  end

  def spec_style
    user = Repo.new
    user.save
    user = Repo.new
    user.load
  end

  def block_each(xs)
    xs.each do |e|
      r = Repo.new
      r.save
      r = Repo.new
      r.load
    end
  end

  def or_assign
    x = Repo.new
    x.save
    x ||= Repo.new
    x.load
  end

  def or_assign_first
    x ||= Repo.new
    x.save
    x = Repo.new
    x.load
  end

  def or_assign_other_class
    x = Other.new
    x.save
    x ||= Repo.new
    x.load
  end

  def captured_same_class(xs)
    r = Repo.new
    xs.each { r = Repo.new }
    r.save
  end

  def different_types
    v = Repo.new
    v.save
    v = Other.new
    v.load
  end

  def sandwich
    x = Repo.new
    x.save
    x = Other.new
    x.save
    x = Repo.new
    x.load
  end

  def captured_other_class(xs)
    r = Repo.new
    r.load
    xs.each { r = Other.new }
    r.save
  end

  def untyped_then_typed
    x = make
    x.save
    x = Repo.new
    x.load
  end

  def captured_parameter(x, xs)
    xs.each { x ||= Repo.new }
    x.save
    xs.each { x = Repo.new }
    x.load
    x = Repo.new
  end
end
`,
  });

  it.each([
    ['if_else', ['11:6 Repo.load', '13:4 Repo.load', '8:6 Repo.save']],
    ['case_when', ['20:6 Repo.save', '23:6 Repo.load']],
    ['retry_shape', ['30:6 Repo.save']],
    ['spec_style', ['39:4 Repo.save', '41:4 Repo.load']],
    ['block_each', ['47:6 Repo.save', '49:6 Repo.load']],
    ['script.rb', ['3:0 Repo.save', '5:0 Repo.load']],
    ['or_assign', ['55:4 Repo.save', '57:4 Repo.load']],
    ['or_assign_first', ['62:4 Repo.save', '64:4 Repo.load']],
    ['or_assign_other_class', ['69:4 Other.save', '71:4 Other.load']],
    ['captured_same_class', ['77:4 Repo.save']],
  ])('types every read between same-class constructor writes: %s', (source, expected) => {
    expect(callsFrom(run(), source)).toEqual(expected);
  });

  it.each([
    // The read on line 82 holds a Repo, the one type fact of `v` says Other.
    ['different_types', ['84:4 Other.load']],
    ['sandwich', ['93:4 Repo.load']],
    ['captured_other_class', ['98:4 Repo.load']],
    ['untyped_then_typed', ['107:4 Repo.load']],
    // The block's `x ||= …` may leave the argument in place: the Repo
    // written later types only the read after the write that always assigns.
    ['captured_parameter', ['114:4 Repo.load']],
  ])('lends no type across a write that may change the class: %s', (source, expected) => {
    expect(callsFrom(run(), source)).toEqual(expected);
  });
});

describe('Ruby local claims: a local never stops a call of the same name', () => {
  const run = useFixture('ruby-local-claims-calls', {
    'script.rb': `# locals and methods of one program scope
def helper(x); end
def path(f); end
def zero; end
def target; end
def top_fn(x); end

helper = 2
helper(1)
path = path("a")
zero = 1

def top_local_before
  helper = 2
  helper(1)
end

def top_local_after
  helper(1)
  helper = 2
end

def top_same_line(f)
  path = path(f)
  path
end

def top_block(xs)
  xs.each do |x|
    helper = x
    helper(x)
  end
end

def top_parens
  target = 1
  target()
end

def top_outer_local(xs)
  top_fn = 1
  xs.each { |x| top_fn(x) }
end

def bare_after_program_local
  zero
end

class Decoy
  def helper(x); end
  def path(f); end
  def zero; end
  def target; end
  def top_fn(x); end
  def inherited(x); end
end

class Base
  def inherited(x); end
end

class Svc < Base
  def path(f); end
  def in_class_same_line(f)
    path = path(f)
    path
  end
  def in_class_inherited
    inherited = inherited(1)
    inherited
  end
  def in_class_top_target
    helper(1)
    helper = 2
  end
  def in_class_top_target_before
    helper = 2
    helper(1)
  end
  def in_class_parameter(helper)
    helper(1)
  end
end

module Mod
  def self.singleton_top_target
    helper = 1
    helper(2)
  end
end
`,
  });

  it.each([
    ['script.rb', ['- helper', '- path']],
    ['top_local_before', ['- helper']],
    ['top_local_after', ['- helper']],
    ['top_same_line', ['- path']],
    ['top_block', ['- helper']],
    ['top_parens', ['- target']],
    ['top_outer_local', ['- top_fn']],
    ['bare_after_program_local', ['- zero']],
  ])('outside a class the call reaches the top-level method: %s', (source, expected) => {
    expect(callsFrom(run(), source)).toEqual(expected);
  });

  it.each([
    ['in_class_same_line', ['65:11 Svc.path']],
    ['in_class_inherited', ['69:16 Base.inherited']],
    ['in_class_top_target', ['73:4 helper']],
    ['in_class_top_target_before', ['78:4 helper']],
    ['in_class_parameter', ['81:4 helper']],
    ['singleton_top_target', ['88:4 helper']],
  ])('inside a class self answers first, then Object: %s', (source, expected) => {
    expect(callsFrom(run(), source)).toEqual(expected);
  });
});

describe('Ruby local claims: self reaches a top-level method required inside a body', () => {
  // `require` in a method or class body is attached to that scope by
  // `rubyImportOwningScope`; the `self` fallback still finds what it loads.
  // `helper` has a second owner so no name guess can answer.
  const run = useFixture('ruby-local-claims-body-require', {
    'helpers.rb': 'def helper(x); end\n',
    'decoy.rb': 'class Decoy\n  def helper(x); end\nend\n',
    'svc.rb': `class InMethod
  def require_in_method
    require_relative 'helpers'
    helper = 2
    helper(1)
  end
end

class InClassBody
  require_relative 'helpers'
  def require_in_class(helper)
    helper(1)
  end
end
`,
  });

  it.each([
    ['require_in_method', ['5:4 helper']],
    ['require_in_class', ['12:4 helper']],
  ])('the call beside a same-named local or parameter: %s', (source, expected) => {
    expect(callsFrom(run(), source)).toEqual(expected);
  });
});

describe('Ruby local claims: a claim belongs to the scope node that declares the local', () => {
  const FIRST_DEF = `def first
  helper = 1
  helper
end

def helper; end

def second
  helper()
end

class Other
  def helper; end
end
`;
  const run = useFixture('ruby-local-claims-first-token', {
    'first_def.rb': FIRST_DEF,
    'first_class.rb': `class Cfg
  defaults = 1
  defaults
end

def defaults; end

def use_it
  defaults()
end

class Decoy
  def defaults; end
end
`,
  });

  it('gives the claim of a first-token def to that def, and none to the program', () => {
    const claimed = emitRubyScopeCaptures(FIRST_DEF, 'first_def.rb')
      .filter((match) => match['@scope.name-claims'] !== undefined)
      .map((match) => Object.keys(match).sort().join(' '));
    expect(claimed).toEqual(['@scope.function @scope.name-claims']);
  });

  it.each([
    ['second', ['- helper']],
    ['use_it', ['- defaults']],
  ])('a later call keeps the top-level method of the file: %s', (source, expected) => {
    expect(callsFrom(run(), source)).toEqual(expected);
  });
});

describe('Ruby local claims: a heredoc body is ordered at its opener', () => {
  const run = useFixture('ruby-local-claims-heredocs', {
    'host.rb': `class User
  def save; end
end
class Other
  def save; end
end
def consume(*args); end

def body_write_read_on_opener_line
  consume(<<~EOS, user.save)
    #{user = Other.new}
  EOS
end

def opener_line_write_read_in_body
  user = User.new
  consume(<<~EOS, user = 42)
    #{user.save}
  EOS
end

class Host
  # @return [User]
  attr_reader :user
  def other(*args); end

  def untyped_body_write
    other(<<~EOS, user.save)
      #{user = 42}
    EOS
  end

  def plain
    user.save
  end

  def body_read_before_body_write
    other(<<~EOS)
      #{user.save} #{user = 42}
    EOS
  end

  def body_write_before_body_read
    other(<<~EOS)
      #{user = Other.new} #{user.save}
    EOS
  end

  def opener_line_write_then_read
    other(<<~EOS, user = Other.new, user.save)
      #{user.save}
    EOS
  end

  def write_between_two_openers
    other(<<~A, user = Other.new, <<~B)
      #{user.save}
    A
      #{user.save}
    B
  end

  def read_after_body
    other(<<~EOS, user = 42)
      text
    EOS
    user.save
  end

  def body_write_then_opener_line_write
    other(<<~EOS, user = 42)
      #{user = Other.new}
    EOS
    user.save
  end
end
`,
  });

  it.each([
    // Prism: every receiver below that has no edge, or an Other edge, is a
    // LocalVariableReadNode; every one with a User edge inside Host is a CallNode.
    ['body_write_read_on_opener_line', ['10:18 Other.save']],
    ['opener_line_write_read_in_body', ['18:6 User.save']],
    ['untyped_body_write', []],
    ['plain', ['34:4 User.save']],
    ['body_read_before_body_write', ['39:8 User.save']],
    ['body_write_before_body_read', ['45:28 Other.save']],
    ['opener_line_write_then_read', ['50:36 Other.save', '51:8 User.save']],
    ['write_between_two_openers', ['57:8 User.save', '59:8 Other.save']],
    ['read_after_body', []],
    ['body_write_then_opener_line_write', []],
  ])('a receiver is typed by the write Ruby parses before it: %s', (source, expected) => {
    expect(callsFrom(run(), source)).toEqual(expected);
  });
});

describe('name claims: visibility spans, evaluation rank and callee lookups', () => {
  const at = (startLine: number, startCol = 0) => ({ startLine, startCol });
  const claim = (line: number, extra: Partial<NameClaim> = {}): NameClaim => ({
    name: 'x',
    kind: 'binding',
    inactive: 'outer',
    availableFrom: at(line),
    range: { startLine: line, startCol: 0, endLine: line, endCol: 1 },
    ...extra,
  });
  const method: SymbolDefinition = { nodeId: 'def:x', filePath: 'a.rb', type: 'Function' };
  const scopeOf = (id: string, parent: string | null, extra: Partial<Scope>): Scope => ({
    id,
    parent,
    kind: 'Function',
    filePath: 'a.rb',
    range: { startLine: 1, startCol: 0, endLine: 99, endCol: 0 },
    bindings: new Map(),
    imports: [],
    ownedDefs: [],
    typeBindings: new Map(),
    ...extra,
  });

  // Visible on 2:4..3:0, hidden until 5:0, then visible from there on.
  const spanned = scopeOf('fn', null, {
    nameClaims: [claim(5, { availableSpans: [at(2, 4), at(3), at(5)] })],
  });
  it.each([
    ['before the first span', at(2, 3), 'absent'],
    ['at the start of the first span', at(2, 4), 'selected'],
    ['inside the first span', at(2, 30), 'selected'],
    ['at the exclusive end of the first span', at(3), 'absent'],
    ['between the spans, after availableFrom would have applied', at(4, 9), 'absent'],
    ['in the open last span', at(7), 'selected'],
  ] as const)('a claim with spans is visible only inside them: %s', (_where, position, status) => {
    expect(selectClaimsAtScope(spanned, 'x', { position }).status).toBe(status);
  });

  it('selects the later of two ranked claims by rank, and of unranked claims by source order', () => {
    const earlierInSource = claim(3, { availableFrom: undefined, order: 9 });
    const laterInSource = claim(6, { availableFrom: undefined, order: 4 });
    const ranked = scopeOf('fn', null, { nameClaims: [earlierInSource, laterInSource] });
    const unranked = scopeOf('fn', null, {
      nameClaims: [claim(3, { availableFrom: undefined }), laterInSource],
    });
    expect(selectClaimsAtScope(ranked, 'x', { position: at(8) }).claims).toEqual([earlierInSource]);
    expect(selectClaimsAtScope(unranked, 'x', { position: at(8) }).claims).toEqual([laterInSource]);
  });

  it('hides a never-callee claim from a callee lookup only', () => {
    const local = claim(2, { neverCallee: true });
    const scopes = [
      scopeOf('fn', 'module', { nameClaims: [local] }),
      scopeOf('module', null, {
        kind: 'Module',
        bindings: new Map([['x', [{ def: method, origin: 'local' as const }]]]),
      }),
    ];
    const sources = { scopes: { getScope: (id: string) => scopes.find((s) => s.id === id) } };
    const lookup = (callee: boolean) =>
      lookupLexicalName('fn', 'x', sources, { position: at(4), purpose: 'value', callee });
    expect(lookup(false).status).toBe('blocked');
    expect(lookup(false).claims).toEqual([local]);
    expect(lookup(true).status).toBe('resolved');
    expect(lookup(true).bindings.map((binding) => binding.def.nodeId)).toEqual(['def:x']);
  });
});
