/**
 * RUBY-02 — a bare identifier that names a parameter or a local is a variable
 * READ, never a method call (docs/languages/ruby-ingestion-gaps.md).
 *
 * The Ruby scope query captures a receiver-less, paren-less identifier that is
 * a statement of its own (`(body_statement (identifier)) @reference.call.free`)
 * as a zero-arity call, because that is what such a name is when no local of
 * that name exists. But Ruby decides the question lexically: once a formal
 * parameter, a block parameter or an earlier assignment has bound the name in
 * the enclosing scope, the bare name is a variable read, and only `target()`,
 * `self.target` or `target arg` still call the method. Before this fix
 * `class Host; def target; end; def run(target); target; end; end` produced a
 * wrong `run → Host#target` CALLS edge.
 *
 * `emitRubyScopeCaptures` now drops the bare capture when the name is bound
 * in the enclosing scope: a formal parameter of the enclosing `def` / lambda
 * (positional, optional, keyword, splat, hash-splat, block), a `|x|` block
 * parameter or `|x; y|` block local of an enclosing block, or a local bound
 * EARLIER in the same scope by assignment (plain, multiple, `||=`), `for`,
 * `rescue =>` or a `case … in` / `=>` pattern. A nested `def` starts a fresh
 * scope, so its body sees none of the outer names; a block sees the names of
 * every enclosing block and the method.
 *
 * Every assertion compares full node IDs. `declared(owner, name)` reads the
 * method's ID off its HAS_METHOD edge, so an empty call list proves the edge
 * is gone, not that the fixture lost the method. The decoy `Other#target`
 * exists so that any kept edge is checked against the exact owner.
 *
 * Each case in the "no edge" suites fails with the guard removed (every one
 * then resolves to `Host#target`); the "edge kept" suite is the control set —
 * those edges held before the fix and must survive it, including `no_shadow`,
 * which pins that a bare name with NO binding is still a call.
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
} from './helpers.js';

const SHADOWED_BY_PARAMETER = [
  'bare_read_param',
  'bare_read_optional_param',
  'bare_read_keyword_param',
  'bare_read_optional_keyword_param',
  'bare_read_splat_param',
  'bare_read_hash_splat_param',
  'bare_read_block_arg_param',
  'bare_read_destructured_param',
] as const;

const SHADOWED_BY_LOCAL = [
  'bare_read_local',
  'bare_read_multi_assign_local',
  'bare_read_op_assign_local',
  'bare_read_for_var',
  'bare_read_rescue_var',
  'bare_read_pattern_bind',
  'bare_read_hash_shorthand_bind',
  'bare_read_rightward_bind',
  // A `begin … end` body holds its statements directly (no `body_statement`),
  // so the statement pattern never captured this read; it is edge-free before
  // and after the fix and pins only that the shape stays that way.
  'bare_read_begin_body_local',
] as const;

const SHADOWED_INSIDE_BLOCK = [
  'bare_read_block_param',
  'bare_read_block_local',
  'bare_read_enclosing_param_in_block',
  'bare_read_enclosing_local_in_block',
  'bare_read_outer_block_param_in_inner_block',
  'bare_read_lambda_enclosing_param',
] as const;

// Parameters bind LEFT-TO-RIGHT: a read inside parameter k's default sees only
// the names declared before it. The statement pattern reaches a default only
// through a `do` block (or lambda `do` body) nested in it, so that is the
// shape used here. Ruby 2.6 verified: the "later" forms return the method's
// value, the "earlier" forms the parameter's, and the self-named default
// (`target = … target …`) reads the (nil) local — a circular reference.
const DEFAULT_READS_LATER_PARAM_KEPT = [
  'default_reads_later_param',
  'default_reads_later_keyword_param',
  'block_default_reads_later_param',
] as const;

// A `begin … end` default holds its statements directly (no `body_statement`),
// so the statement pattern never captures its read: no edge before or after
// the fix, whatever the parameter order. Silent, documented; pinned as `[]`
// with the existence check so a future capture of that shape shows up here.
const DEFAULT_BEGIN_NOT_CAPTURED = [
  'default_begin_reads_later_param',
  'default_begin_reads_earlier_param',
] as const;

const DEFAULT_READS_EARLIER_PARAM = [
  'default_reads_earlier_param',
  'default_reads_earlier_keyword_param',
  'default_reads_self_name',
  'block_default_reads_earlier_param',
] as const;

// A rightward `value => pattern` / `value in pattern` parses the VALUE before
// the pattern declares anything (Ruby 3 pattern matching), so a bare read
// inside the value is still a call; the pattern's names bind only after it.
const PATTERN_VALUE_READS_BEFORE_BIND_KEPT = [
  'rightward_value_reads_before_bind',
  'test_pattern_value_reads_before_bind',
  // A name binds where it is WRITTEN: in `arr[… target …], target = …` the
  // first target's subscript is parsed before the second target declares it.
  'multi_assign_target_reads_before_bind',
] as const;

// Round 5 (mirrored from the enterprise port's second-vendor review): three
// shapes where the filter dropped a REAL call. A header expression Ruby
// evaluates in the ENCLOSING scope — a singleton method's receiver, a class's
// superclass, a `class << value` value — binds there, never in the body; a
// `BEGIN { … }` / `END { … }` body is its own scope; a pattern's expression
// parts (a string / regex `interpolation`, a `lambda` pattern's parameters)
// are not binding positions.
const HEADER_OR_PATTERN_PART_EDGE_KEPT = [
  'begin_block_assign_does_not_bind',
  'end_block_assign_does_not_bind',
  'string_interpolation_pattern_does_not_bind',
  'regex_interpolation_pattern_does_not_bind',
  'lambda_pattern_param_does_not_bind',
  'singleton_class_header_name_is_not_a_binding',
] as const;

/** True pattern binding positions (controls for the pattern allow-list). */
const PATTERN_BINDING_POSITIONS_NO_EDGE = [
  'const_array_pattern_arg_binds',
  'const_hash_pattern_value_binds',
  'find_pattern_binds',
  'alternative_pattern_binds',
  'parenthesized_pattern_binds',
] as const;

const EDGE_KEPT = [
  'no_shadow',
  'explicit_call_paren',
  'self_call',
  'call_with_args',
  'read_before_assign',
  'block_param_does_not_leak',
  'block_local_does_not_leak',
  'sibling_block_local_does_not_leak',
  'block_without_binding',
] as const;

describe('Ruby bare identifier naming a parameter or local is a read, not a call (RUBY-02)', () => {
  let result: PipelineResult;
  let tmpDir: string;
  let hostTargetId: string;
  let otherTargetId: string;

  const declared = (owner: string, name: string): string => {
    const edge = getRelationships(result, 'HAS_METHOD').find(
      (e) => e.source === owner && e.target === name,
    );
    if (edge === undefined) throw new Error(`fixture lost ${owner}#${name}`);
    return edge.rel.targetId;
  };

  const targetCallsFrom = (sourceId: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((c) => c.rel.sourceId === sourceId && c.target === 'target')
      .map((e) => e.rel.targetId);

  const targetCallsFromName = (sourceName: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((c) => c.source === sourceName && c.target === 'target')
      .map((e) => e.rel.targetId);

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-bare-read-shadows-method-'));
    writeFixtureRepo(tmpDir, {
      'host.rb': `class Other
  def target(*args)
    false
  end
end

class Host
  def target(*args)
    true
  end

  # ── shadowed by a formal parameter: no edge ──────────────────────────

  def bare_read_param(target)
    target
  end

  def bare_read_optional_param(target = nil)
    target
  end

  def bare_read_keyword_param(target:)
    target
  end

  def bare_read_optional_keyword_param(target: nil)
    target
  end

  def bare_read_splat_param(*target)
    target
  end

  def bare_read_hash_splat_param(**target)
    target
  end

  def bare_read_block_arg_param(&target)
    target
  end

  def bare_read_destructured_param((a, target))
    target
  end

  # ── shadowed by a local bound earlier in the method: no edge ─────────

  def bare_read_local
    target = 1
    target
  end

  def bare_read_multi_assign_local
    a, target = 1, 2
    target
  end

  def bare_read_op_assign_local
    target ||= 1
    target
  end

  def bare_read_for_var
    for target in [1]
    end
    target
  end

  def bare_read_rescue_var
    begin
      raise 'x'
    rescue => target
    end
    target
  end

  def bare_read_pattern_bind(v)
    case v
    in [target]
    end
    target
  end

  def bare_read_hash_shorthand_bind(v)
    case v
    in {target:}
    end
    target
  end

  def bare_read_rightward_bind(v)
    v => target
    target
  end

  def bare_read_begin_body_local
    target = 1
    begin
      target
    end
  end

  # ── shadowed inside a block or lambda body: no edge ──────────────────

  def bare_read_block_param(x)
    [1].each do |target|
      target
    end
  end

  def bare_read_block_local(x)
    [1].each do |a; target|
      target
    end
  end

  def bare_read_enclosing_param_in_block(target)
    [1].each do |a|
      target
    end
  end

  def bare_read_enclosing_local_in_block
    target = 1
    [1].each do |a|
      target
    end
  end

  def bare_read_outer_block_param_in_inner_block(x)
    [1].each do |target|
      [2].each do |b|
        target
      end
    end
  end

  def bare_read_lambda_enclosing_param(target)
    lambda_outer = -> do
      target
    end
    lambda_outer
  end

  def bare_read_lambda_param(x)
    lambda_shadow = ->(target) do
      target
    end
    lambda_shadow
  end

  # ── parameters bind left-to-right: a default sees only earlier names ─

  def default_reads_later_param(x = [1].each do |a| target end, target: nil)
    x
  end

  def default_reads_later_keyword_param(x: [1].each do |a| target end, target: nil)
    x
  end

  def block_default_reads_later_param(x)
    [1].map { |a = [2].map do |b| target end, target| a }
  end

  def lambda_default_reads_later_param(x)
    lambda_default_later = ->(y = [1].each do |a| target end, target: nil) do
      y
    end
    lambda_default_later
  end

  def default_begin_reads_later_param(x = begin; target; end, target: nil)
    x
  end

  def default_begin_reads_earlier_param(target = nil, x = begin; target; end)
    x
  end

  def default_reads_earlier_param(target = nil, x = [1].each do |a| target end)
    x
  end

  def default_reads_earlier_keyword_param(target: nil, x: [1].each do |a| target end)
    x
  end

  def default_reads_self_name(target = [1].each do |a| target end)
    x = target
  end

  def block_default_reads_earlier_param(x)
    [1].map { |target, a = [2].map do |b| target end| a }
  end

  # ── rightward patterns bind after the value they match ───────────────

  def rightward_value_reads_before_bind
    [1].each do |a| target end => target
  end

  def test_pattern_value_reads_before_bind
    [1].each do |a| target end in target
  end

  def multi_assign_target_reads_before_bind
    arr = []
    arr[[1].map do |x| target end], target = [], 1
  end

  # ── a header expression is evaluated in the enclosing scope ──────────

  def (target = Object.new).singleton_receiver_assign_body_reads_method
    target
  end

  def header_read_sees_enclosing_param(target)
    def ([1].each do target end).header_inner
    end
  end

  def singleton_class_header_read_sees_param(target)
    class << ([1].each do target end)
    end
  end

  def make_base(*args)
    true
  end

  def singleton_class_header_name_is_not_a_binding
    class << make_base
    end
    make_base
  end

  # ── BEGIN / END bodies and pattern expression parts do not bind ──────

  def begin_block_assign_does_not_bind
    BEGIN { target = 1 }
    target
  end

  def end_block_assign_does_not_bind
    END { target = 1 }
    target
  end

  def string_interpolation_pattern_does_not_bind(v)
    case v
    in "x#{target}"
    end
    target
  end

  def regex_interpolation_pattern_does_not_bind(v)
    case v
    in /#{target}/
    end
    target
  end

  def lambda_pattern_param_does_not_bind(v)
    case v
    in ->(target) { 0 }
    end
    target
  end

  def const_array_pattern_arg_binds(v)
    case v
    in Other(target)
    end
    target
  end

  def const_hash_pattern_value_binds(v)
    case v
    in Other(k: target)
    end
    target
  end

  def find_pattern_binds(v)
    case v
    in [*, target, *]
    end
    target
  end

  def alternative_pattern_binds(v)
    case v
    in nil | target
    end
    target
  end

  def parenthesized_pattern_binds(v)
    case v
    in (target)
    end
    target
  end

  # ── nested def: a fresh scope ────────────────────────────────────────

  def bare_read_nested_def_outer
    def nested_def_shadow(target)
      target
    end
  end

  def nested_def_does_not_see_outer_param(target)
    def nested_def_reads_method
      target
    end
  end

  # ── controls: the edge is kept ───────────────────────────────────────

  def no_shadow(other)
    target
  end

  def explicit_call_paren(other)
    target()
  end

  def self_call(target)
    self.target
  end

  def call_with_args(other)
    target 1
  end

  def read_before_assign
    target
    target = 1
  end

  def block_param_does_not_leak(x)
    [1].each do |target|
    end
    target
  end

  def block_local_does_not_leak(x)
    [1].each do |a; target|
    end
    target
  end

  def sibling_block_local_does_not_leak(x)
    [1].each do |a|
      target = a
    end
    target
  end

  def block_without_binding(x)
    [1].each do |a|
      target
    end
  end

  def lambda_without_binding(x)
    lambda_reader = -> do
      target
    end
    lambda_reader
  end
end
`,
    });
    result = await runPipelineFromRepo(tmpDir, () => {});
    hostTargetId = declared('Host', 'target');
    otherTargetId = declared('Other', 'target');
    expect(hostTargetId).not.toBe(otherTargetId);
  }, 60000);

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it.each(SHADOWED_BY_PARAMETER)('%s: a bare read of a formal parameter emits no edge', (fn) => {
    expect(targetCallsFrom(declared('Host', fn))).toEqual([]);
  });

  it.each(SHADOWED_BY_LOCAL)('%s: a bare read of an earlier-bound local emits no edge', (fn) => {
    expect(targetCallsFrom(declared('Host', fn))).toEqual([]);
  });

  it.each(SHADOWED_INSIDE_BLOCK)(
    '%s: a bare read inside a block sees the enclosing bindings and emits no edge',
    (fn) => {
      expect(targetCallsFrom(declared('Host', fn))).toEqual([]);
    },
  );

  it('bare_read_lambda_param: a lambda parameter shadows the method for the lambda body', () => {
    // An assigned lambda is declared as a Function named after its local and
    // is its own call source, so the assertion runs on that node.
    expect(getNodesByLabel(result, 'Function')).toContain('lambda_shadow');
    expect(targetCallsFromName('lambda_shadow')).toEqual([]);
    expect(targetCallsFrom(declared('Host', 'bare_read_lambda_param'))).toEqual([]);
  });

  it('nested_def_shadow: a nested def parameter shadows the method for its own body', () => {
    expect(targetCallsFrom(declared('Host', 'nested_def_shadow'))).toEqual([]);
    expect(targetCallsFrom(declared('Host', 'bare_read_nested_def_outer'))).toEqual([]);
  });

  it('nested_def_reads_method: a nested def does not see the outer parameter, so its bare name is a call (kept)', () => {
    expect(targetCallsFrom(declared('Host', 'nested_def_reads_method'))).toEqual([hostTargetId]);
  });

  it.each(DEFAULT_READS_LATER_PARAM_KEPT)(
    '%s: a default reading a parameter declared AFTER it is a call (kept)',
    (fn) => {
      expect(targetCallsFrom(declared('Host', fn))).toEqual([hostTargetId]);
    },
  );

  it('lambda_default_reads_later_param: a lambda default reading a later lambda parameter is a call (kept)', () => {
    // The default's block sits inside the lambda node, so the site is owned by
    // whichever callable the pipeline encloses it in; assert the edge exists
    // exactly once between the two candidates.
    const fromLambda = targetCallsFromName('lambda_default_later');
    const fromMethod = targetCallsFrom(declared('Host', 'lambda_default_reads_later_param'));
    expect([...fromLambda, ...fromMethod]).toEqual([hostTargetId]);
  });

  it.each(PATTERN_VALUE_READS_BEFORE_BIND_KEPT)(
    '%s: a bare read parsed before the name is written is a call (kept)',
    (fn) => {
      expect(targetCallsFrom(declared('Host', fn))).toEqual([hostTargetId]);
    },
  );

  it('singleton_receiver_assign_body_reads_method: an assignment in the singleton receiver binds the ENCLOSING scope, so the body read is a call (kept)', () => {
    // `def (target = Object.new).m` is a singleton method on a fresh object;
    // the receiver expression runs in the class body, not in `m`.
    const name = 'singleton_receiver_assign_body_reads_method';
    expect([
      ...getNodesByLabel(result, 'Method'),
      ...getNodesByLabel(result, 'Function'),
    ]).toContain(name);
    expect(targetCallsFromName(name)).toEqual([hostTargetId]);
  });

  it('header_read_sees_enclosing_param: a do-block read inside a singleton receiver sees the ENCLOSING method parameter (no edge)', () => {
    // The receiver expression runs in `header_read_sees_enclosing_param`,
    // whose parameter binds `target`; the pipeline may attribute the site to
    // either callable, so neither may carry the edge.
    expect(getNodesByLabel(result, 'Method')).toContain('header_inner');
    expect(targetCallsFromName('header_inner')).toEqual([]);
    expect(targetCallsFrom(declared('Host', 'header_read_sees_enclosing_param'))).toEqual([]);
  });

  it('singleton_class_header_read_sees_param: a do-block read inside `class << value` sees the enclosing method parameter (no edge)', () => {
    expect(targetCallsFrom(declared('Host', 'singleton_class_header_read_sees_param'))).toEqual([]);
  });

  it.each(HEADER_OR_PATTERN_PART_EDGE_KEPT)(
    '%s: a BEGIN/END assignment, a pattern expression part or a bare header name does not bind, so the later bare name still calls',
    (fn) => {
      const callee = fn === 'singleton_class_header_name_is_not_a_binding' ? 'make_base' : 'target';
      const edges = getRelationships(result, 'CALLS')
        .filter((c) => c.rel.sourceId === declared('Host', fn) && c.target === callee)
        .map((e) => e.rel.targetId);
      expect(edges).toEqual([declared('Host', callee)]);
    },
  );

  it.each(PATTERN_BINDING_POSITIONS_NO_EDGE)(
    '%s: a true pattern binding position binds the later bare name (no edge)',
    (fn) => {
      expect(targetCallsFrom(declared('Host', fn))).toEqual([]);
    },
  );

  it.each(DEFAULT_BEGIN_NOT_CAPTURED)(
    '%s: a `begin … end` default is not captured by the query (pre-existing); silent, documented',
    (fn) => {
      expect(targetCallsFrom(declared('Host', fn))).toEqual([]);
    },
  );

  it.each(DEFAULT_READS_EARLIER_PARAM)(
    '%s: a default reading a parameter declared before it (or its own name) emits no edge',
    (fn) => {
      expect(targetCallsFrom(declared('Host', fn))).toEqual([]);
    },
  );

  it.each(EDGE_KEPT)('%s: still calls the exact Host#target', (fn) => {
    expect(targetCallsFrom(declared('Host', fn))).toEqual([hostTargetId]);
  });

  it('lambda_without_binding: a lambda body with no binding of the name still calls Host#target', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('lambda_reader');
    expect(targetCallsFromName('lambda_reader')).toEqual([hostTargetId]);
  });

  it('never picks the decoy Other#target from any function', () => {
    const toDecoy = getRelationships(result, 'CALLS').filter(
      (c) => c.rel.targetId === otherTargetId,
    );
    expect(toDecoy).toEqual([]);
  });
});
