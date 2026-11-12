/**
 * RUBY-03 — a block, lambda or method parameter stops the receiver type walk
 * (docs/languages/ruby-ingestion-gaps.md).
 *
 * The shared receiver walk (`lookupLexicalName`) stops at the nearest scope
 * that owns the receiver's name, and a scope owns an untyped name only when it
 * lists it in `Scope.lexicalNames`. Ruby listed nothing, so a parameter with no
 * type of its own was invisible to the walk, which climbed past it and took the
 * type of a same-named binding further out:
 *
 *   user = User.new
 *   items.each { |user| user.save }   # was User#save — the element is not a User
 *
 * `emitRubyScopeCaptures` now publishes `@scope.lexical-names` on every scope
 * that declares parameters: a `do … end` / `{ … }` block (its `|…|` names,
 * block locals included), the body of a stabby lambda (`->(x) { … }`, whose
 * parameters sit outside the body block), and a method. Each binder lands on
 * the scope that declares it, never on the enclosing body, so an outer use of
 * the same name keeps its type.
 *
 * With the stop in place, the YARD `@param` decline (RUBY-01) no longer fires
 * for a block, lambda or nested-def parameter of the tagged name: the tagged
 * use beside the shadow resolves, and the shadow stays untyped. A stabby lambda
 * whose parameter DEFAULT reads the name still declines, because the parameter
 * list sits outside the lambda body.
 *
 * Every call site is asserted exactly against owner node IDs, with a decoy
 * `AuditLog#save` so that an untyped receiver has two candidates and a
 * name-only guess would show up as a wrong edge instead of hiding behind a
 * unique name.
 *
 * Recall note (pinned below): an explicit call — `target()`, `target(1)`,
 * `target 1` — inside a block whose parameter is also named `target` now
 * resolves to nothing. In Ruby it still calls the method; the lexical name
 * blocks free-call lookup for that name, as it already did beside a method
 * parameter of that name (ruby-param-shadow-call.test.ts). The same lookup
 * makes a BARE `target` beside such a parameter a read rather than a call,
 * which is what Ruby does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

/** Materialize `files`, run the pipeline once, and clean up after the block. */
function useFixture(prefix: string, files: Record<string, string>): () => PipelineResult {
  let root = '';
  let result: PipelineResult | undefined;
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), `gitnexus-${prefix}-`));
    writeFixtureRepo(root, files);
    result = await runPipelineFromRepo(root, () => {});
  }, 60000);
  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });
  return () => {
    if (result === undefined) throw new Error('pipeline did not run');
    return result;
  };
}

/**
 * Every CALLS edge to a method named `member` from the source named `source`,
 * as `targetId @line:col`. The call site comes from the relationship id suffix,
 * so two sites with the same endpoints stay distinct.
 */
function callsFrom(result: PipelineResult, source: string, member: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === source && edge.target === member)
    .map((edge) => {
      const suffix = edge.rel.id.slice(
        edge.rel.id.lastIndexOf(edge.rel.targetId) + edge.rel.targetId.length,
      );
      const site = /^:(\d+):(\d+)/.exec(suffix);
      return `${edge.rel.targetId} @${site === null ? '-' : `${site[1]}:${site[2]}`}`;
    })
    .sort();
}

/** The node ID of `owner#member`, from its HAS_METHOD edge. */
function methodId(result: PipelineResult, owner: string, member: string): string {
  const edge = getRelationships(result, 'HAS_METHOD').find(
    (e) => e.source === owner && e.target === member,
  );
  if (edge === undefined) throw new Error(`fixture lost ${owner}#${member}`);
  return edge.rel.targetId;
}

/** Every resolution outcome recorded for `name` at `file:line:col`, as `kind:reason-or-target`. */
function outcomesAt(
  result: PipelineResult,
  file: string,
  line: number,
  col: number,
  name: string,
): string[] {
  return getResolutionOutcomes(result)
    .flatMap((outcome) => {
      if (outcome.kind === 'reexport-ambiguous') return [];
      if (outcome.filePath !== file || outcome.name !== name) return [];
      if (outcome.range.startLine !== line || outcome.range.startCol !== col) return [];
      if (outcome.kind === 'suppressed') return [`suppressed:${outcome.reason}`];
      if (outcome.kind === 'resolved') return [`resolved:${outcome.targetId}`];
      return [outcome.kind];
    })
    .sort();
}

const MODELS = `class User
  def save; end
end

class AuditLog
  def save; end
end
`;

describe('Ruby block parameters stop the receiver walk (RUBY-03)', () => {
  const run = useFixture('ruby03-blocks', {
    'models.rb': MODELS,
    'blocks.rb': `require_relative 'models'

def do_shadow(items)
  user = User.new
  items.each do |user|
    user.save
  end
  user.save
end

def brace_shadow(items)
  user = User.new
  items.each { |user| user.save }
  user.save
end

def control_capture(items)
  user = User.new
  items.each { |item| user.save }
end

def nested_inner_shadow(groups)
  user = User.new
  groups.each do |group|
    group.each { |user| user.save }
    user.save
  end
end

def nested_outer_shadow(groups)
  user = User.new
  groups.each do |user|
    [1].each { |n| user.save }
  end
end

def param_forms(items)
  user = User.new
  items.each { |x; user| user.save }
  items.each { |(a, user)| user.save }
  items.each { |*user| user.save }
  items.each { |user:| user.save }
  items.each { |a, user = nil| user.save }
  items.each { |&user| user.save }
end

def assigned_in_block(items)
  items.each { |user| user = User.new; user.save }
end
`,
  });
  let userSave = '';
  beforeAll(() => {
    userSave = methodId(run(), 'User', 'save');
    expect(methodId(run(), 'AuditLog', 'save')).not.toBe(userSave);
  });

  it('do |user| … end: the block site resolves to nothing; the outer use keeps User#save', () => {
    expect(callsFrom(run(), 'do_shadow', 'save')).toEqual([`${userSave} @8:2`]);
  });

  it('{ |user| … }: the block site resolves to nothing; the outer use keeps User#save', () => {
    expect(callsFrom(run(), 'brace_shadow', 'save')).toEqual([`${userSave} @14:2`]);
  });

  it('control: a block whose parameter shadows nothing still reads the captured outer local', () => {
    expect(callsFrom(run(), 'control_capture', 'save')).toEqual([`${userSave} @19:22`]);
  });

  it('nested: the inner block owns its |user|; the outer block, which binds only |group|, reaches the local', () => {
    expect(callsFrom(run(), 'nested_inner_shadow', 'save')).toEqual([`${userSave} @26:4`]);
  });

  it('nested: an inner block without the name stops at the enclosing block that binds it', () => {
    expect(callsFrom(run(), 'nested_outer_shadow', 'save')).toEqual([]);
  });

  it('every parameter form binds: block local, destructured, splat, keyword, optional, &block', () => {
    expect(callsFrom(run(), 'param_forms', 'save')).toEqual([]);
  });

  it('a block parameter rebound to a constructor inside the block takes that type', () => {
    expect(callsFrom(run(), 'assigned_in_block', 'save')).toEqual([`${userSave} @48:39`]);
  });

  it('the stopped block site records an unresolved receiver without an edge', () => {
    // DART-11 records the walk stopping at an untyped lexical binder.
    expect(outcomesAt(run(), 'blocks.rb', 6, 4, 'save')).toEqual([
      'suppressed:receiver-type-unresolved',
    ]);
    expect(outcomesAt(run(), 'blocks.rb', 13, 22, 'save')).toEqual([
      'suppressed:receiver-type-unresolved',
    ]);
    // The outer use beside it resolves.
    expect(outcomesAt(run(), 'blocks.rb', 8, 2, 'save')).toEqual([
      'resolved:def:models.rb#2:2:Method:save',
    ]);
  });
});

describe('Ruby lambda and proc parameters stop the receiver walk (RUBY-03)', () => {
  const run = useFixture('ruby03-lambdas', {
    'models.rb': MODELS,
    'lambdas.rb': `require_relative 'models'

def lambda_shadow
  user = User.new
  stabby = ->(user) { user.save }
  stabby_do = ->(user) do
    user.save
  end
  bare = -> user { user.save }
  kw = lambda { |user| user.save }
  pr = proc { |user| user.save }
  pn = Proc.new { |user| user.save }
  user.save
end

def lambda_control
  user = User.new
  reader = -> { user.save }
  other = ->(x) { user.save }
end
`,
  });
  let userSave = '';
  beforeAll(() => {
    userSave = methodId(run(), 'User', 'save');
  });

  it.each(['stabby', 'stabby_do', 'bare'] as const)(
    '%s: a stabby lambda parameter (outside the body block) binds in the body',
    (fn) => {
      expect(callsFrom(run(), fn, 'save')).toEqual([]);
    },
  );

  it.each(['kw', 'pr', 'pn'] as const)('%s: a lambda/proc block parameter binds', (fn) => {
    expect(callsFrom(run(), fn, 'save')).toEqual([]);
  });

  it('the enclosing method keeps its own typed local', () => {
    expect(callsFrom(run(), 'lambda_shadow', 'save')).toEqual([`${userSave} @13:2`]);
  });

  it.each([
    ['reader', 18, 16],
    ['other', 19, 18],
  ] as const)(
    'control: %s, a lambda that does not bind the name, captures the outer local',
    (fn, line, col) => {
      expect(callsFrom(run(), fn, 'save')).toEqual([`${userSave} @${line}:${col}`]);
    },
  );
});

describe('Ruby method parameters stop the receiver walk (RUBY-03)', () => {
  const run = useFixture('ruby03-methods', {
    'models.rb': MODELS,
    'methods.rb': `require_relative 'models'

class Holder
  def account
    User.new
  end

  def implicit_self
    account.save
  end

  def param_named_like_reader(account)
    account.save
  end
end

top_user = User.new

def top_param(top_user)
  top_user.save
end

# @param user [User]
def outer_typed(user)
  def inner_untyped(user)
    user.save
  end
  user.save
end
`,
    'reader.rb': `require_relative 'models'

class Reader
  def initialize; end

  # @return [User]
  attr_reader :owner

  def uses_reader
    owner.save
  end

  def param_named_like_attr(owner)
    owner.save
  end
end
`,
  });
  let userSave = '';
  beforeAll(() => {
    userSave = methodId(run(), 'User', 'save');
  });

  it('control: an implicit-self reader call keeps the class-level return type', () => {
    expect(callsFrom(run(), 'implicit_self', 'save')).toEqual([`${userSave} @9:4`]);
  });

  it('an untyped parameter named like a typed reader does not borrow the reader type', () => {
    expect(callsFrom(run(), 'param_named_like_reader', 'save')).toEqual([]);
  });

  it('an untyped parameter does not borrow a same-named top-level local', () => {
    expect(callsFrom(run(), 'top_param', 'save')).toEqual([]);
  });

  it('an untyped parameter named like a YARD-typed attr_reader does not borrow its @return type', () => {
    // The accessor's type is published on the class scope; before RUBY-03 a
    // sibling method's same-named parameter climbed to it.
    expect(callsFrom(run(), 'uses_reader', 'save')).toEqual([`${userSave} @10:4`]);
    expect(callsFrom(run(), 'param_named_like_attr', 'save')).toEqual([]);
  });

  it('a nested def parameter does not borrow the enclosing method tag; the tagged use keeps it', () => {
    expect(callsFrom(run(), 'inner_untyped', 'save')).toEqual([]);
    expect(callsFrom(run(), 'outer_typed', 'save')).toEqual([`${userSave} @28:2`]);
  });
});

describe('Ruby YARD @param beside a shadowing block parameter (RUBY-03 + RUBY-01)', () => {
  const run = useFixture('ruby03-yard', {
    'models.rb': `class User
  # @return [User]
  def me
    self
  end

  def save; end
end

class AuditLog
  def save; end
end
`,
    'yard.rb': `require_relative 'models'

# @param user [User]
def yard_block_shadow(user, items)
  items.each { |user| user.save }
  user.save
end

# @param user [User]
def yard_lambda_shadow(user)
  check = ->(user) { user.save }
  user.save
end

# @param user [User]
def yard_block_local(user, items)
  items.each { |x; user| user.save }
  user.save
end

# @param user [User]
def yard_block_rebinds(user, items)
  items.each { |x| user = AuditLog.new }
  user.save
end

# @param user [User]
def yard_block_alias(user, items)
  items.each { |user| other = user; other.save }
  user.save
end

# @param user [User]
def yard_block_chain(user, items)
  items.each { |user| user.me.save }
  user.me.save
end

# @param user [User]
def yard_lambda_default_read(user)
  pick = ->(user, fallback = user.save) { fallback }
  user.save
end
`,
  });
  let userSave = '';
  beforeAll(() => {
    userSave = methodId(run(), 'User', 'save');
  });

  it('the block parameter types nothing; the tagged parameter outside the block keeps User#save', () => {
    expect(callsFrom(run(), 'yard_block_shadow', 'save')).toEqual([`${userSave} @6:2`]);
  });

  it('the lambda parameter types nothing; the tagged parameter keeps User#save', () => {
    expect(callsFrom(run(), 'check', 'save')).toEqual([]);
    expect(callsFrom(run(), 'yard_lambda_shadow', 'save')).toEqual([`${userSave} @12:2`]);
  });

  it('a block local types nothing; the tagged parameter keeps User#save', () => {
    expect(callsFrom(run(), 'yard_block_local', 'save')).toEqual([`${userSave} @18:2`]);
  });

  it('an assignment to the parameter inside a block still declines the tag (RUBY-01, unchanged)', () => {
    expect(callsFrom(run(), 'yard_block_rebinds', 'save')).toEqual([]);
  });

  it('an alias of the block parameter takes no type from the tag', () => {
    expect(callsFrom(run(), 'yard_block_alias', 'save')).toEqual([`${userSave} @30:2`]);
  });

  it('a chain on the block parameter takes no type from the tag; the outer chain keeps it', () => {
    expect(callsFrom(run(), 'yard_block_chain', 'save')).toEqual([`${userSave} @36:2`]);
  });

  it('a stabby lambda whose parameter default reads the shadowing name still declines the tag', () => {
    // `->(user, fallback = user.save)`: the parameter list sits outside the
    // lambda body, so the default's `user` would otherwise climb to the tag.
    expect(callsFrom(run(), 'yard_lambda_default_read', 'save')).toEqual([]);
    expect(callsFrom(run(), 'pick', 'save')).toEqual([]);
  });
});

describe('Ruby iteration over a YARD-typed collection (RUBY-03 must not regress)', () => {
  const run = useFixture('ruby03-iterate', {
    'models.rb': MODELS,
    'iterate.rb': `require_relative 'models'

# @param users [Array<User>]
def iterate_typed(users)
  users.each { |u| u.save }
  for v in users
    v.save
  end
end
`,
  });

  it('a block over a typed collection stays unresolved (as before); `for … in` keeps its element type', () => {
    const userSave = methodId(run(), 'User', 'save');
    expect(callsFrom(run(), 'iterate_typed', 'save')).toEqual([`${userSave} @7:4`]);
  });
});

describe('Ruby free calls beside a same-named block parameter (RUBY-03)', () => {
  const run = useFixture('ruby03-free-calls', {
    'host.rb': `class Host
  def target(*args)
    true
  end

  def bare_read
    [1].each do |target|
      target
    end
  end

  def unrelated_param_bare
    [1].each do |x|
      target
    end
  end

  def explicit_call_with_arg
    [1].each { |target| target(1) }
  end

  def explicit_call_paren
    [1].each { |target| target() }
  end

  def explicit_call_command
    [1].each { |target| target 1 }
  end

  def bare_param_read(target)
    target
  end
end
`,
  });

  it('a bare read of the block parameter is a read, not a call to Host#target', () => {
    expect(callsFrom(run(), 'bare_read', 'target')).toEqual([]);
  });

  it('control: a bare name that no parameter binds still calls Host#target', () => {
    const hostTarget = methodId(run(), 'Host', 'target');
    expect(callsFrom(run(), 'unrelated_param_bare', 'target').map((s) => s.split(' @')[0])).toEqual(
      [hostTarget],
    );
  });

  it('a bare read of a method parameter is a read, not a call to Host#target', () => {
    expect(callsFrom(run(), 'bare_param_read', 'target')).toEqual([]);
  });

  it.each(['explicit_call_with_arg', 'explicit_call_paren', 'explicit_call_command'] as const)(
    'recall cost: %s, an explicit call beside a same-named block parameter, resolves to nothing',
    (fn) => {
      // Ruby still calls the method here. The block parameter's lexical name
      // blocks free-call lookup for that name, as a same-named method
      // parameter already did (ruby-param-shadow-call.test.ts).
      expect(callsFrom(run(), fn, 'target')).toEqual([]);
    },
  );
});

describe('DART-11 Ruby characterization, flipped (RUBY-03)', () => {
  const run = useFixture('ruby03-dart11', {
    'models.rb': `class Address
  def save_rb; end
end

class Other
  def save_rb; end
end
`,
    'app.rb': `require_relative 'models'

def f_rb(items)
  cs = Address.new
  items.each do |cs|
    cs.save_rb
  end
  cs.save_rb
end
`,
  });

  it('the block site (6:4) has no edge; the outer use (8:2) keeps Address#save_rb', () => {
    const addressSave = methodId(run(), 'Address', 'save_rb');
    expect(callsFrom(run(), 'f_rb', 'save_rb')).toEqual([`${addressSave} @8:2`]);
  });
});
