# Python CFG hazard fixture. Exercises every control-flow construct the Python
# visitor models, including the EXIT-reachability hazard (`while True:` with no
# static exit) the CDG soundness gate depends on, plus the structural divergences
# from the brace family: indentation blocks, elif, for/while-else, with,
# try/except/except*/else/finally, match/case, comprehensions, and the def shapes
# (tuple/list unpack, walrus, augmented assign, global/nonlocal, *args/**kwargs).


def if_elif_else(x):
    """if / elif / else branch senses."""
    if x > 0:
        r = positive()
    elif x < 0:
        r = negative()
    else:
        r = zero()
    return r


def for_else(xs):
    """for-else: the else runs on NORMAL completion, not on break."""
    found = None
    for i in xs:
        if matches(i):
            found = i
            break
    else:
        found = default()
    return found


def while_else(x):
    """while-else: same else-on-normal-completion / not-on-break semantics."""
    while x > 0:
        if done(x):
            break
        x -= 1
    else:
        finished()
    return x


def while_true_loop(x):
    """while True: keeps EXIT reverse-reachable (CDG soundness hazard)."""
    while True:
        if should_stop(x):
            return collect()
        x = step(x)


def with_dispose(path):
    """with runs __exit__ on BOTH the normal and the exception exit."""
    with open(path) as fh, lock() as l:
        data = fh.read()
        use(l)
    return process(data)


def with_early_return(path):
    """a return inside a `with` threads through the dispose."""
    with open(path) as fh:
        return fh.read()


def try_except_else_finally(payload):
    """try / except / except* / else / finally completion edges."""
    try:
        result = parse(payload)
    except ValueError as e:
        result = recover(e)
    except (TypeError, KeyError):
        result = fallback()
    else:
        validate(result)
    finally:
        cleanup()
    return result


def try_except_group(payload):
    """except* group handler."""
    try:
        body(payload)
    except* ValueError as eg:
        handle_group(eg)


def match_dispatch(command):
    """match / case: no fallthrough; the no-wildcard path keeps EXIT reachable."""
    match command:
        case "start":
            on_start()
        case ["move", x, y]:
            on_move(x, y)
        case {"kind": k} if k > 0:
            on_kind(k)
        case _:
            on_default()
    return ack()


def defs_and_uses(a, b=1, *args, **kwargs):
    """tuple/list unpack, walrus, augmented assign, comprehension, global."""
    global COUNTER
    x, y = compute(a, b)
    [p, q] = pair()
    first, *rest = sequence(args)
    if (n := length(kwargs)) > 0:
        total = n + x + y + p + q
    squares = [i * i for i in rest if i > 0]
    COUNTER += 1
    return total if a else squares


def nested_loops_labels(matrix):
    """nested loops with continue/break and a comprehension target."""
    out = []
    for row in matrix:
        for cell in row:
            if cell is None:
                continue
            if cell < 0:
                break
            out.append(cell)
    return [v for v in out]
