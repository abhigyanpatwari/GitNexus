# Ruby CFG hazard fixture. Exercises every control-flow construct the Ruby
# visitor models, including the EXIT-reachability hazard (`while true` / `loop do`
# with no static exit) the CDG soundness gate depends on, plus the Ruby-specific
# shapes: keyword/`end`-delimited blocks, elsif/unless, the statement-modifier
# forms (`x if c`, `x while c`), until (inverted), case/when (no fallthrough),
# case/in pattern matching, begin/rescue/else/ensure (+ method-level implicit
# begin), retry, blocks/lambdas as closures, next/break/redo, and the def shapes
# (multiple assignment, operator-assign, block params, rescue `=> e`).

def if_elif_else(x)
  # if / elsif / else branch senses.
  if x > 0
    r = positive()
  elsif x < 0
    r = negative()
  else
    r = zero()
  end
  r
end

def unless_form(x)
  # unless inverts the sense — the body is the cond-false arm.
  guard() unless x
  done()
end

def modifier_forms(c)
  # statement-modifier if / while.
  y = compute() if c
  step() while c
  y
end

def while_loop(x)
  # while: header + body + loop-back.
  while x > 0
    x -= 1
  end
  x
end

def until_loop
  # until inverts: the body runs while the condition is FALSE.
  until done?
    advance()
  end
end

def for_loop(xs)
  # for: the loop var is a def, the iterable a use.
  total = 0
  for i in xs
    total += i
  end
  total
end

def infinite_loop(x)
  # `while true` with no static exit — the EXIT-reachability / CDG hazard. The
  # structural cond-false escape edge keeps the post-dominator pass running.
  while true
    handle() if x
  end
end

def loop_block
  # `loop do … end` — the block is its own closure CFG; its body's normal
  # fall-off must keep the block EXIT reverse-reachable.
  loop do
    work()
  end
end

def case_when(x)
  # case/when — no fallthrough between case bodies.
  case x
  when 1
    one()
  when 2, 3
    two_or_three()
  else
    other()
  end
end

def case_in(obj)
  # case/in pattern matching — no fallthrough; the patterns bind.
  case obj
  in [a, b]
    pair(a, b)
  in { id: } if id > 0
    by_id(id)
  in Integer
    int()
  else
    no_match()
  end
end

def begin_rescue_else_ensure
  # begin/rescue/else/ensure — ensure runs on every path; the else only on the
  # no-exception path; the protected body throws to the handler.
  begin
    risky()
  rescue StandardError => e
    handle(e)
  rescue TypeError
    handle_type()
  else
    no_error()
  ensure
    cleanup()
  end
  after()
end

def method_implicit_begin
  # a method body is an implicit begin — trailing rescue/ensure thread correctly.
  perform()
rescue => err
  recover(err)
ensure
  finalize()
end

def retry_loop
  # retry re-enters the begin protected body.
  attempts = 0
  begin
    attempts += 1
    connect()
  rescue
    retry if attempts < 3
  end
end

def return_through_ensure(x)
  # a return inside begin threads through ensure (finally-return).
  begin
    return early() if x
    body()
  ensure
    release()
  end
end

def block_jumps(xs)
  # next ≈ continue, break exits, redo re-runs the block body.
  xs.each do |n|
    next if n.skip?
    break if n.stop?
    redo if n.retry?
    use(n)
  end
end

def def_shapes(a, b = 1, *rest, key:, **opts, &blk)
  # def shapes: defaults, splat, kwsplat, keyword, block param; multiple assign;
  # operator-assign; instance/class/global vars (NOT scalar local defs).
  first, second = a, b
  total = first
  total += second
  @cache = total
  @@registry = rest
  $global = opts
  blk.call(key) if blk
  total
end

square = ->(q) { q * q }
doubler = lambda { |r| r + r }
