/**
 * RUBY-01 — YARD `@param` types must bind to the DECLARING method, never to
 * the enclosing class/module (docs/languages/ruby-ingestion-gaps.md).
 *
 * The YARD pass in `languages/ruby/captures.ts` anchors every synthesized
 * `@type-binding.parameter` on the `method` node. Pass 4 of the scope
 * extractor auto-hoists a binding whose anchor range EQUALS the innermost
 * scope's range to that scope's parent (built for Python's
 * `@type-binding.return`, whose anchor is the `function_definition`). A method
 * node is its own `@scope.function`, so the parameter binding used to land on
 * the Class (or Module, for a top-level `def`) scope — and every sibling with
 * a same-named parameter borrowed it. `rubyBindingScopeFor` now pins
 * `@type-binding.parameter` to the innermost (method) scope.
 *
 * Contract, per sibling pair and in BOTH declaration orders:
 *   - the typed call resolves to the exact `User#save` node ID, and only it;
 *   - the untyped sibling's call stays unresolved (no CALLS edge at all);
 *   - the decoy `AuditLog#save` is never chosen by anyone.
 *
 * Four pairs: typed-first in a class, untyped-first in a class, a
 * top-level pair (Module scope is the parent there — the shape the receiver
 * benchmark recorded), and a pair whose tag uses the alternate YARD order
 * `@param [Type] name` (a second capture path in the YARD pass). The decoy exists so an unresolved receiver has TWO
 * `save` candidates: a name-only guess would be visible as a wrong edge
 * rather than hidden behind a unique name.
 *
 * The second and third suites are the review corpus for the pin, retargeted
 * to pin-only expectations: RUBY-01 ships WITHOUT inferring an instance
 * variable's type from a YARD-typed parameter (per-file capture cannot see
 * class reopenings, mixins or generated writers, so that inference could
 * still publish a wrong field type — see "Future: field typing from typed
 * parameters" in docs/languages/ruby-ingestion-gaps.md). Every `@user.save`
 * after `@user = user`, and every `holder.user.save` through `attr_reader`,
 * is therefore a DOCUMENTED MISSING EDGE asserted as `[]`; a YARD `@return`
 * on a hand-written reader still types its chain; and no untyped program may
 * ever reach `User#save` or `AuditLog#save`. Missing beats wrong.
 *
 * The fourth suite guards the pin's own side effect: in the method scope the
 * tag's `parameter-annotation` fact outranks a local's `constructor-inferred`
 * one, so a tag may only type a name that is a formal parameter, is never
 * REBOUND in the body (binding-target semantics: the name itself, or the name
 * reached through a destructuring list, `for`, `rescue =>`, a block/lambda/
 * nested-def parameter, or a `case … in` / rightward pattern — including the
 * hash shorthand `{user:}`), and is not `self`. A write INTO the parameter
 * (`user.name = x`, `user[0] = 1`, `user.count += 1`, `user.a, user.b = …`),
 * a read as a block-parameter default, a pinned `^user` or `^(user)`, and a
 * read inside a nested block or lambda all keep the tag. Every rebinding
 * case asserts `[]` with the guard and flips to a wrong User#save without
 * it; of the kept cases, ten were lost on fdb945742 (mention-based guard)
 * and `expression_pin_read` on f4d0f8a64 — the rest are controls that also
 * held before.
 *
 * The fifth suite pins the review's reassign-then-use table (coercion,
 * decorator, association and use-before-rebind idioms): a declined tag makes
 * the method resolve exactly like its untagged twin, and every case there
 * fails with the guard removed. The in-class reader forms (`user.save`,
 * `self.user.save` through `attr_reader :user`) are pinned in the second
 * suite: main resolved them only through the leaked class-scope binding. The
 * sixth suite pins that a bare `@type [T]` synthesizes no binding (the removed
 * capture bound the empty name). The last suite pins the `@return`-above-
 * `attr_reader` boundary named in the gaps doc: as the FIRST statement of a
 * class body the tag is not attached (`findFollowingAttrCall` has no
 * `body_statement` descent), so the in-class read is a missing edge, while
 * the same tag after another statement types the read. Explicit `target()`
 * beside a same-named parameter lives in ruby-param-shadow-call.test.ts
 * (pre-existing behaviour, passes on main).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getNodesByLabel,
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
  type RelEdge,
} from './helpers.js';
import { emitRubyScopeCaptures } from '../../../src/core/ingestion/languages/ruby/index.js';

const TYPED = ['typed_first_typed', 'untyped_first_typed', 'top_typed', 'alt_order_typed'] as const;
const UNTYPED = [
  'typed_first_untyped',
  'untyped_first_untyped',
  'top_untyped',
  'alt_order_untyped',
] as const;

describe('Ruby YARD @param binds to the declaring method, not its siblings (RUBY-01)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;

  const saveCallsFrom = (source: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === 'save');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-yard-param-scope-'));
    writeFixtureRepo(tmpDir, {
      'models.rb': `class User
  def save
    true
  end
end

class AuditLog
  def save
    false
  end
end
`,
      'typed_first.rb': `require_relative 'models'

class TypedFirst
  # @param user [User]
  def typed_first_typed(user)
    user.save
  end

  def typed_first_untyped(user)
    user.save
  end
end
`,
      'untyped_first.rb': `require_relative 'models'

class UntypedFirst
  def untyped_first_untyped(user)
    user.save
  end

  # @param user [User]
  def untyped_first_typed(user)
    user.save
  end
end
`,
      'top_level.rb': `require_relative 'models'

# @param user [User]
def top_typed(user)
  user.save
end

def top_untyped(user)
  user.save
end
`,
      'alt_order.rb': `require_relative 'models'

class AltOrder
  # @param [User] user
  def alt_order_typed(user)
    user.save
  end

  def alt_order_untyped(user)
    user.save
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    // Exact owner IDs come from the graph, not from a hand-written string, so
    // the assertions below compare full node IDs rather than member names.
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === 'save');
      if (edge === undefined) throw new Error(`fixture lost ${owner}#save`);
      return edge.rel.targetId;
    };
    userSaveId = own('User');
    decoySaveId = own('AuditLog');
    expect(userSaveId).not.toBe(decoySaveId);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(TYPED)('%s resolves user.save to the exact User#save node', (fn) => {
    const edges = saveCallsFrom(fn);
    expect(edges.map((e) => e.rel.targetId)).toEqual([userSaveId]);
  });

  it.each(UNTYPED)('%s (untyped sibling) keeps user.save unresolved', (fn) => {
    // The leak made this edge point at User#save through the typed sibling's
    // YARD tag — a wrong edge, not a missing one. Nothing may be emitted here.
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it('never picks the decoy AuditLog#save from any function', () => {
    const toDecoy = getRelationships(result, 'CALLS').filter((c) => c.rel.targetId === decoySaveId);
    expect(toDecoy).toEqual([]);
  });
});

describe('Ruby YARD @param on initialize does not type the ivar (documented boundary)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;

  const saveCallsFrom = (source: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === 'save');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-yard-ivar-boundary-'));
    writeFixtureRepo(tmpDir, {
      'models.rb': `class User
  def save
    true
  end
end

class AuditLog
  def save
    false
  end
end
`,
      'holders.rb': `require_relative 'models'

class TypedHolder
  attr_reader :user

  # @param user [User]
  def initialize(user)
    @user = user
  end

  def typed_inside
    @user.save
  end

  def typed_sibling(user)
    user.save
  end

  def reader_inside
    user.save
  end

  def self_reader_inside
    self.user.save
  end
end

class UntypedHolder
  attr_reader :user

  def initialize(user)
    @user = user
  end

  def untyped_inside
    @user.save
  end
end

class ShadowedHolder
  attr_reader :user

  # @param user [User]
  def initialize(user)
    user = AuditLog.new
    @user = user
  end
end
`,
      'app.rb': `require_relative 'holders'

# @param holder [TypedHolder]
def typed_holder_chain(holder)
  holder.user.save
end

# @param holder [UntypedHolder]
def untyped_holder_chain(holder)
  holder.user.save
end

# @param holder [ShadowedHolder]
def shadowed_holder_chain(holder)
  holder.user.save
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === 'save');
      if (edge === undefined) throw new Error(`fixture lost ${owner}#save`);
      return edge.rel.targetId;
    };
    userSaveId = own('User');
    decoySaveId = own('AuditLog');
    expect(userSaveId).not.toBe(decoySaveId);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['typed_inside', 'typed_holder_chain'] as const)(
    '%s stays unresolved: the tag types the parameter, never the ivar (boundary)',
    (fn) => {
      expect(saveCallsFrom(fn)).toEqual([]);
    },
  );

  it("keeps the parameter type away from a sibling method's untyped `user` parameter", () => {
    expect(saveCallsFrom('typed_sibling')).toEqual([]);
  });

  it.each(['reader_inside', 'self_reader_inside'] as const)(
    '%s: the in-class attr_reader forms (`user.save`, `self.user.save`) no longer resolve — main typed them only through the leaked class-scope `user` binding',
    (fn) => {
      expect(saveCallsFrom(fn)).toEqual([]);
    },
  );

  it.each(['untyped_holder_chain', 'untyped_inside'] as const)(
    '%s stays unresolved when initialize(user) carries no YARD tag',
    (fn) => {
      expect(saveCallsFrom(fn)).toEqual([]);
    },
  );

  it('does not type anything from a parameter that was rewritten as a local', () => {
    expect(saveCallsFrom('shadowed_holder_chain')).toEqual([]);
  });

  it('never picks User#save or the decoy AuditLog#save from any function', () => {
    const picked = getRelationships(result, 'CALLS').filter(
      (c) => c.rel.targetId === userSaveId || c.rel.targetId === decoySaveId,
    );
    expect(picked.map((c) => `${c.source} -> ${c.rel.targetId}`)).toEqual([]);
  });
});

describe('Ruby YARD ivar typing review corpus: documented boundaries (these hold on main by design — the pin never types an ivar)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;

  const saveCallsFrom = (source: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === 'save');
  const saveTargets = (source: string): string[] =>
    saveCallsFrom(source).map((e) => e.rel.targetId);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-yard-review-corpus-'));
    writeFixtureRepo(tmpDir, {
      'models.rb': `class User
  def save
    true
  end
end

class AuditLog
  def save
    false
  end
end
`,
      'f3_override.rb': `require_relative 'models'

class OverrideHolder
  attr_reader :user

  # @return [AuditLog]
  def user
    AuditLog.new
  end

  # @param user [User]
  def initialize(user)
    @user = user
  end
end

class DefineMethodHolder
  attr_reader :user

  define_method(:user) { AuditLog.new }

  # @param user [User]
  def initialize(user)
    @user = user
  end
end
`,
      'f4_conflict.rb': `require_relative 'models'

class ConflictHolder
  # @param user [User]
  def initialize(user)
    @user = user
  end

  # @param log [AuditLog]
  def replace(log)
    @user = log
  end

  def conflict_persist
    @user.save
  end
end

class AgreeHolder
  # @param user [User]
  def initialize(user)
    @user = user
  end

  # @param other [User]
  def replace(other)
    @user = other
  end

  def agree_persist
    @user.save
  end
end

class NilWriteHolder
  # @param user [User]
  def initialize(user)
    @user = user
  end

  def reset
    @user = nil
  end

  def nil_write_persist
    @user.save
  end
end
`,
      'r3_ownership.rb': `require_relative 'models'

class BlockWriteHolder
  # @param user [User]
  def initialize(user)
    @user = user
    [AuditLog.new].each { |log| @user = log }
  end

  def block_write_persist
    @user.save
  end
end

class IvarMultiAssignHolder
  # @param user [User]
  def initialize(user)
    @user = user
    @user, unused = AuditLog.new, nil
  end

  def ivar_multi_assign_persist
    @user.save
  end
end

class ReopenedHolder
  # @param user [User]
  def initialize(user)
    @user = user
  end

  def reopened_persist
    @user.save
  end
end

class ReopenedHolder
  def replace(log)
    @user = log
  end
end

class CrossFileHolder
  # @param user [User]
  def initialize(user)
    @user = user
  end

  def cross_file_persist
    @user.save
  end
end

module Storage
  # @param user [User]
  def initialize(user)
    @user = user
  end

  def mixin_persist
    @user.save
  end
end

class MixinHolder
  include Storage

  def replace(log)
    @user = log
  end
end

class AccessorWriterHolder
  attr_accessor :user

  # @param user [User]
  def initialize(user)
    @user = user
  end

  def accessor_writer_persist
    @user.save
  end
end

class AttrWriterHolder
  attr_writer :user

  # @param user [User]
  def initialize(user)
    @user = user
  end

  def attr_writer_persist
    @user.save
  end
end

class ArrayParamHolder
  # @param users [Array<User>]
  def initialize(users)
    @users = users
  end

  def array_param_persist
    @users.save
  end
end
`,
      'r3_reopen_other_file.rb': `require_relative 'r3_ownership'

class CrossFileHolder
  def replace(log)
    @user = log
  end
end
`,
      'app.rb': `require_relative 'f3_override'
require_relative 'r3_ownership'
require_relative 'r3_reopen_other_file'

# @param holder [OverrideHolder]
def f3_override_chain(holder)
  holder.user.save
end

# @param holder [DefineMethodHolder]
def f3_define_method_chain(holder)
  holder.user.save
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string, method: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === method);
      if (edge === undefined) throw new Error(`fixture lost ${owner}#${method}`);
      return edge.rel.targetId;
    };
    userSaveId = own('User', 'save');
    decoySaveId = own('AuditLog', 'save');
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a hand-written reader keeps its own @return [AuditLog]', () => {
    expect(saveTargets('f3_override_chain')).toEqual([decoySaveId]);
  });

  it('a define_method(:user) reader is untyped', () => {
    expect(saveCallsFrom('f3_define_method_chain')).toEqual([]);
  });

  it.each(['conflict_persist', 'agree_persist', 'nil_write_persist'] as const)(
    'typed writes: %s stays unresolved (boundary)',
    (fn) => {
      expect(saveCallsFrom(fn)).toEqual([]);
    },
  );

  it.each([
    'block_write_persist',
    'ivar_multi_assign_persist',
    'reopened_persist',
    'cross_file_persist',
    'mixin_persist',
    'accessor_writer_persist',
    'attr_writer_persist',
    'array_param_persist',
  ] as const)('ownership and writer hazards: %s stays unresolved', (fn) => {
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it('no untyped program ever reaches User#save or AuditLog#save', () => {
    const wrong = getRelationships(result, 'CALLS').filter(
      (c) =>
        (c.rel.targetId === userSaveId || c.rel.targetId === decoySaveId) &&
        c.source !== 'f3_override_chain',
    );
    expect(wrong.map((c) => `${c.source} -> ${c.rel.targetId}`)).toEqual([]);
  });
});

describe('Ruby YARD @param beside a rebound local: every rebinding form declines the tag, every write INTO the variable keeps it', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;
  let selfTaggedSaveId: string;

  const saveCallsFrom = (source: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === 'save');
  const saveTargets = (source: string): string[] =>
    saveCallsFrom(source).map((e) => e.rel.targetId);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-yard-rebound-local-'));
    writeFixtureRepo(tmpDir, {
      'models.rb': `class User
  attr_accessor :name, :count, :a, :b
  def save
    true
  end
end

class AuditLog
  def save
    false
  end
end
`,
      'rebound.rb': `require_relative 'models'

# Every method here carries a tag that is WRONG for the value the call sees:
# with the guard the tag is declined (no edge); without it the tag wins and
# the call resolves to User#save against an AuditLog.
class Rebound
  # @param user [AuditLog]
  def ra(user)
    user = User.new
    user.save
  end

  # @param user [AuditLog]
  def dd(account)
    user = User.new
    user.save
  end

  # @param user [User]
  def multi_assign(user)
    a, user = 1, AuditLog.new
    user.save
  end

  # @param user [User]
  def trailing_comma(user)
    user, = [AuditLog.new]
    user.save
  end

  # @param user [User]
  def nested_destructure(user)
    (a, user), b = [[1, AuditLog.new], 2]
    user.save
  end

  # @param user [User]
  def splat_assign(user)
    a, *user = 1, AuditLog.new
    user.save
  end

  # @param user [User]
  def or_assign(user)
    user ||= AuditLog.new
    user.save
  end

  # @param user [User]
  def op_assign(user)
    user += 1
    user.save
  end

  # @param user [User]
  def for_loop(user)
    for user in [AuditLog.new]
    end
    user.save
  end

  # @param user [User]
  def for_multi(user)
    for a, user in [[1, AuditLog.new]]
    end
    user.save
  end

  # @param user [User]
  def rescue_var(user)
    begin
      raise 'x'
    rescue => user
    end
    user.save
  end

  # @param user [User]
  def implicit_rescue(user)
    user.save
  rescue => user
    user.save
  end

  # @param user [User]
  def block_param(user)
    [AuditLog.new].each { |user| user.save }
  end

  # @param user [User]
  def block_local(user)
    [1].each { |x; user| user.save }
  end

  # @param user [User]
  def lambda_param(user)
    lambda_shadow = ->(user) { user.save }
  end

  # @param user [User]
  def nested_def(user)
    def nested_def_inner(user)
      user.save
    end
    user.save
  end

  # @param user [User]
  def hash_pattern_shorthand(user, payload)
    case payload
    in {user:}
      user.save
    end
  end

  # @param user [User]
  def rightward_hash_shorthand(user, payload)
    payload => {user:}
    user.save
  end

  # @param user [User]
  def test_pattern_hash(user, payload)
    if payload in {user:}
      user.save
    end
  end

  # @param user [User]
  def array_pattern(user, v)
    case v
    in [user]
      user.save
    end
  end

  # @param user [User]
  def as_pattern_in_hash(user, v)
    case v
    in {u: AuditLog => user}
      user.save
    end
  end

  # @param user [User]
  def splat_pattern(user, v)
    case v
    in [*user]
      user.save
    end
  end

  # @param user [User]
  def hash_splat_pattern(user, v)
    case v
    in {**user}
      user.save
    end
  end
end
`,
      'kept.rb': `require_relative 'models'

# Every method here writes INTO the parameter or merely reads it; the tag must
# keep typing the call (exact User#save). "lost on fdb945742" marks the ten
# cases the mention-based guard declined; expression_pin_read was lost on
# f4d0f8a64; the rest are controls that also held before.
class Kept
  # @param user [User]  (lost on fdb945742)
  def attr_write(user, n)
    user.name = n
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def other_attr_named_user(post, user)
    post.user = user
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def self_attr_write(user)
    self.user = user
    user.save
  end

  def user=(value)
    @user = value
  end

  # @param user [User]  (lost on fdb945742)
  def index_write(user)
    user[0] = 1
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def memo_index_key(user)
    @cache[user.id] = user
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def attr_op_assign(user)
    user.count += 1
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def safe_nav_write(user, x)
    user&.name = x
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def masgn_attr(user)
    user.a, user.b = 1, 2
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def block_param_default_read(user, xs)
    xs.each { |x, y = user| y }
    user.save
  end

  # @param user [User]  (lost on fdb945742)
  def pin_pattern_read(user, v)
    case v
    in ^user then 1
    end
    user.save
  end

  # @param user [User]  (lost on f4d0f8a64)
  def expression_pin_read(user, payload)
    case payload
    in ^(user) then 1
    end
    user.save
  end

  # @param user [User]  (control: held on fdb945742)
  def read_in_block(user)
    [1].each { user.save }
  end

  # @param user [User]  (control: held on fdb945742)
  def read_in_lambda(user)
    lambda_reader = -> { user.save }
  end

  # @param user [User]  (control: held on fdb945742)
  def read_in_lambda_call(user)
    -> { user.save }.call
  end

  # @param user [User]  (control: held on fdb945742)
  def other_local_eq_user(user)
    other = user
    user.save
  end

  # @param user [User]  (control: held on fdb945742)
  def hash_value(user)
    opts = { user: user }
    user.save
  end

  # @param user [User]  (control: held on fdb945742)
  def keyword_arg_call(user)
    g(user: user)
    user.save
  end

  # @param user [User]  (control: held on fdb945742)
  def tagged_formal_kept(user)
    user.save
  end
end

class SelfTagged
  def save
    true
  end

  # @param self [AuditLog]
  def self_tagged
    save
  end
end
`,
      'constructs.rb': `require_relative 'models'

class Constructs
  # @param user [User]
  def self.singleton_typed(user)
    user.save
  end

  def self.singleton_untyped(user)
    user.save
  end

  class << self
    # @param user [User]
    def eigen_typed(user)
      user.save
    end

    def eigen_untyped(user)
      user.save
    end
  end

  # @param user [User]
  def endless_typed(user) = user.save

  def endless_untyped(user) = user.save
end

module Outer
  module Inner
    class Deep
      # @param user [User]
      def deep_typed(user)
        user.save
      end

      def deep_untyped(user)
        user.save
      end
    end

    # @param user [User]
    def self.module_singleton_typed(user)
      user.save
    end

    def self.module_singleton_untyped(user)
      user.save
    end
  end
end

RSpec.describe 'constructs' do
  # @param user [User]
  def spec_typed(user)
    user.save
  end

  def spec_untyped(user)
    user.save
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === 'save');
      if (edge === undefined) throw new Error(`fixture lost ${owner}#save`);
      return edge.rel.targetId;
    };
    userSaveId = own('User');
    decoySaveId = own('AuditLog');
    selfTaggedSaveId = own('SelfTagged');
    expect(userSaveId).not.toBe(decoySaveId);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['ra', 'dd'] as const)(
    '%s: a local `user = User.new` beats a `@param user [AuditLog]` tag (exact User#save)',
    (fn) => {
      expect(saveTargets(fn)).toEqual([userSaveId]);
    },
  );

  it.each([
    'multi_assign',
    'trailing_comma',
    'nested_destructure',
    'splat_assign',
    'or_assign',
    'op_assign',
    'for_loop',
    'for_multi',
    'rescue_var',
    'implicit_rescue',
    'block_param',
    'block_local',
    'lambda_shadow',
    'nested_def',
    'nested_def_inner',
    'hash_pattern_shorthand',
    'rightward_hash_shorthand',
    'test_pattern_hash',
    'array_pattern',
    'as_pattern_in_hash',
    'splat_pattern',
    'hash_splat_pattern',
  ] as const)('rebinding: %s declines the tag — no edge (User#save would be wrong)', (fn) => {
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it.each([
    'attr_write',
    'other_attr_named_user',
    'self_attr_write',
    'index_write',
    'memo_index_key',
    'attr_op_assign',
    'safe_nav_write',
    'masgn_attr',
    'block_param_default_read',
    'pin_pattern_read',
    'expression_pin_read',
    'read_in_block',
    'lambda_reader',
    'read_in_lambda_call',
    'other_local_eq_user',
    'hash_value',
    'keyword_arg_call',
    'tagged_formal_kept',
  ] as const)(
    'kept: %s writes into or reads the parameter, so the tag still types it (exact User#save)',
    (fn) => {
      expect(saveTargets(fn)).toEqual([userSaveId]);
    },
  );

  it('self_tagged: `@param self` never retypes the receiver (bare save stays SelfTagged#save)', () => {
    expect(saveTargets('self_tagged')).toEqual([selfTaggedSaveId]);
  });

  it('an assigned lambda is its own call source, so the lambda cases above are asserted on it', () => {
    // `lambda_shadow = ->(user) { … }` / `lambda_reader = -> { … }` are declared
    // as Functions named after the local; their calls are emitted from them.
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('lambda_shadow');
    expect(fns).toContain('lambda_reader');
  });

  // Known unguarded rebindings — a regex named capture `/(?<user>\w+)/ =~ s`,
  // `binding.local_variable_set(:user, …)` and `eval` — are recorded in
  // docs/languages/ruby-ingestion-gaps.md, not as `it.todo`: CI's execution
  // audit (scripts/test-completeness.ts) counts a todo as unverified.

  it.each([
    'singleton_typed',
    'eigen_typed',
    'endless_typed',
    'deep_typed',
    'module_singleton_typed',
    'spec_typed',
  ] as const)('construct coverage: %s resolves to the exact User#save', (fn) => {
    expect(saveTargets(fn)).toEqual([userSaveId]);
  });

  it.each([
    'singleton_untyped',
    'eigen_untyped',
    'endless_untyped',
    'deep_untyped',
    'module_singleton_untyped',
    'spec_untyped',
  ] as const)('construct coverage: untyped sibling %s stays unresolved', (fn) => {
    expect(saveCallsFrom(fn)).toEqual([]);
  });

  it('never picks the decoy AuditLog#save from any function', () => {
    const toDecoy = getRelationships(result, 'CALLS').filter((c) => c.rel.targetId === decoySaveId);
    expect(toDecoy.map((c) => `${c.source} -> ${c.rel.targetId}`)).toEqual([]);
  });
});

describe('Ruby YARD @param beside the reassign-then-use idioms: a declined tag resolves exactly like its untagged twin', () => {
  // The review table for the pin (PR #3871): with the tag in the method scope,
  // its `parameter-annotation` fact (strength 2) would beat the local's
  // `constructor-inferred` one (strength 1) whatever the statement order, so
  // the coercion and decorator idioms below would resolve through the tag.
  // The rebinding guard declines the tag instead, so each method resolves as
  // its untagged twin (and as main) does. Every case here fails with the guard
  // removed (`yardParamNameIsBindable` -> true); none depends on the pin.
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let userFullNameId: string;
  let auditSaveId: string;
  let optionsSaveId: string;
  let decoratorFullNameId: string;

  const targetsOf = (source: string, method: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((c) => c.source === source && c.target === method)
      .map((e) => e.rel.targetId);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-yard-reassign-idioms-'));
    writeFixtureRepo(tmpDir, {
      'models.rb': `class User
  def save
    true
  end

  def full_name
    'u'
  end

  # @return [Account]
  def account
    Account.new
  end
end

class AuditLog
  def save
    false
  end
end

class Account
  def save
    true
  end
end

class Options
  def initialize(hash)
  end

  def save
    true
  end
end

class UserDecorator
  def initialize(user)
  end

  def full_name
    'd'
  end
end
`,
      'idioms.rb': `require_relative 'models'

class Idioms
  # @param user [User]
  def reassign_then_use(user)
    user = AuditLog.new
    user.save
  end

  def reassign_then_use_untagged(user)
    user = AuditLog.new
    user.save
  end

  # @param user [User]
  def decorate(user)
    user = UserDecorator.new(user)
    user.full_name
  end

  # @param user [User]
  def follow_association(user)
    user = user.account
    user.save
  end

  # @param opts [Hash]
  def coerce(opts)
    opts = Options.new(opts)
    opts.save
  end

  # @param user [User]
  def use_before_rebind(user)
    user.save
    user = AuditLog.new
  end

  def use_before_rebind_untagged(user)
    user.save
    user = AuditLog.new
  end
end

# @param user [User]
def top_reassign_then_use(user)
  user = AuditLog.new
  user.save
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string, method: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === method);
      if (edge === undefined) throw new Error(`fixture lost ${owner}#${method}`);
      return edge.rel.targetId;
    };
    userSaveId = own('User', 'save');
    userFullNameId = own('User', 'full_name');
    auditSaveId = own('AuditLog', 'save');
    optionsSaveId = own('Options', 'save');
    decoratorFullNameId = own('UserDecorator', 'full_name');
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(['reassign_then_use', 'top_reassign_then_use'] as const)(
    '%s: `user = AuditLog.new; user.save` under `@param user [User]` resolves to the local (exact AuditLog#save), like its untagged twin',
    (fn) => {
      expect(targetsOf(fn, 'save')).toEqual([auditSaveId]);
      expect(targetsOf(fn, 'save')).toEqual(targetsOf('reassign_then_use_untagged', 'save'));
    },
  );

  it('decorate: `user = UserDecorator.new(user); user.full_name` resolves to the decorator (exact UserDecorator#full_name)', () => {
    expect(targetsOf('decorate', 'full_name')).toEqual([decoratorFullNameId]);
  });

  it('coerce: `opts = Options.new(opts); opts.save` under `@param opts [Hash]` keeps the local (exact Options#save)', () => {
    expect(targetsOf('coerce', 'save')).toEqual([optionsSaveId]);
  });

  it('follow_association: `user = user.account; user.save` gets no edge (User#save would be wrong; Account#save is a missing edge, as on main)', () => {
    expect(targetsOf('follow_association', 'save')).toEqual([]);
  });

  it('use_before_rebind: `user.save; user = AuditLog.new` resolves exactly like its untagged twin — the pre-existing flow-insensitive local answer (AuditLog#save, as on main), pinned on purpose', () => {
    expect(targetsOf('use_before_rebind', 'save')).toEqual(
      targetsOf('use_before_rebind_untagged', 'save'),
    );
    expect(targetsOf('use_before_rebind', 'save')).toEqual([auditSaveId]);
  });

  it('no rebound method reaches User#save or User#full_name through its declined tag', () => {
    const picked = getRelationships(result, 'CALLS').filter(
      (c) => c.rel.targetId === userSaveId || c.rel.targetId === userFullNameId,
    );
    expect(picked.map((c) => `${c.source} -> ${c.rel.targetId}`)).toEqual([]);
  });
});

describe('Ruby YARD `@type [T]` synthesizes no type binding (the inert capture was removed)', () => {
  it('a bare `# @type [User]` above a method emits no @type-binding.parameter capture (it used to bind the empty name, which nothing reads)', () => {
    const src = `class TypeTagOnly
  # @type [User]
  def type_only(user)
    user.save
  end
end
`;
    const names = emitRubyScopeCaptures(src, 'type_only.rb')
      .filter((m) => m['@type-binding.parameter'] !== undefined)
      .map((m) => m['@type-binding.name']?.text);
    expect(names).toEqual([]);
  });
});

describe('Ruby YARD @return above attr_reader: first statement of the class body is not attached (documented boundary)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let userSaveId: string;
  let decoySaveId: string;

  const saveCallsFrom = (source: string): RelEdge[] =>
    getRelationships(result, 'CALLS').filter((c) => c.source === source && c.target === 'save');

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-yard-return-attr-first-'));
    writeFixtureRepo(tmpDir, {
      'models.rb': `class User
  def save
    true
  end
end

class AuditLog
  def save
    false
  end
end
`,
      'readers.rb': `require_relative 'models'

class FirstStatementReader
  # @return [User]
  attr_reader :user

  def initialize(user)
    @user = user
  end

  def first_statement_reader_inside
    user.save
  end
end

class LaterStatementReader
  LABEL = 'later'

  # @return [User]
  attr_reader :user

  def initialize(user)
    @user = user
  end

  def later_statement_reader_inside
    user.save
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});

    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const own = (owner: string): string => {
      const edge = hasMethod.find((e) => e.source === owner && e.target === 'save');
      if (edge === undefined) throw new Error(`fixture lost ${owner}#save`);
      return edge.rel.targetId;
    };
    userSaveId = own('User');
    decoySaveId = own('AuditLog');
    expect(userSaveId).not.toBe(decoySaveId);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('first_statement_reader_inside: a `@return` on an attr_reader that opens the class body is not attached, so the in-class `user.save` is a missing edge (pre-existing; flips to User#save if `findFollowingAttrCall` gains the `body_statement` descent — update docs/languages/ruby-ingestion-gaps.md with it)', () => {
    expect(saveCallsFrom('first_statement_reader_inside')).toEqual([]);
  });

  it('later_statement_reader_inside (control): the same tag after another statement types the in-class read to the exact User#save', () => {
    expect(saveCallsFrom('later_statement_reader_inside').map((e) => e.rel.targetId)).toEqual([
      userSaveId,
    ]);
  });

  it('never picks the decoy AuditLog#save from any function', () => {
    const toDecoy = getRelationships(result, 'CALLS').filter((c) => c.rel.targetId === decoySaveId);
    expect(toDecoy).toEqual([]);
  });
});
