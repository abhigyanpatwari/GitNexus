def run_other; end
def run_sweep; end
def run_then; end
def run_else; end

# Each branch holds one statement, so each branch is the value.
def single_statement_if(fast)
  run = if fast
    method(:run_then)
  else
    method(:run_else)
  end
  run.call
end

# The `then` branch evaluates to 0; `h` is only read by an inner statement,
# so it must not flow into `run`.
def statement_if(fast)
  h = method(:run_other)
  run = if fast
    g = h
    0
  else
    method(:run_sweep)
  end
  run.call
end
