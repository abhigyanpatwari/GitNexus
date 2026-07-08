// Dart CFG hazard fixture (#2195) — one of every control-flow shape the Dart
// CfgVisitor models, so the worker-roundtrip / integration passes exercise the
// real (vendored) grammar end-to-end. Mirrors the sibling fixtures
// (kotlin-hazards, swift-hazards, java-hazards). Dart splits a function into a
// SIGNATURE + a sibling `function_body`, and `if`/`switch`-expression/`?:`/`??`
// are expressions — this fixture stresses statement-position constructs plus a
// few value-position ones (which stay inline as harvest may-defs).

// if / else-if / else + a value-position `?:` (stays inline) + arrow body.
int branching(int x) {
  if (x > 0) {
    positive();
  } else if (x < 0) {
    negative();
  } else {
    zero();
  }
  final sign = x >= 0 ? 1 : -1; // value-position conditional — not a branch
  return sign;
}

// switch statement: empty-case fallthrough, an explicit `continue LABEL`, a
// default, and a no-implicit-fallthrough non-empty case.
void dispatch(int x) {
  switch (x) {
    case 1:
    case 2:
      small();
      break;
    case 3:
      medium();
      continue big;
    big:
    case 4:
      large();
      break;
    default:
      other();
  }
  after();
}

// switch EXPRESSION used as a value — stays inline (no branch edges).
int classify(int x) {
  return switch (x) {
    1 => 10,
    2 => 20,
    _ => 0,
  };
}

// for-in (binds the loop var) + c-style for + while + do-while (bottom-test).
void loops(List items) {
  for (var item in items) {
    consume(item);
  }
  for (var i = 0; i < 10; i++) {
    index(i);
  }
  while (running()) {
    tick();
  }
  do {
    retry();
  } while (shouldRetry());
}

// while (true) {} — keeps EXIT reverse-reachable (structural escape edge).
void spin(bool stop) {
  while (true) {
    if (stop) {
      break;
    }
    work();
  }
  done();
}

// try / on / catch / finally — exception flow + finally completion edges.
int guarded() {
  try {
    return risky();
  } on FormatException catch (e, st) {
    handle(e, st);
  } catch (err) {
    fallback(err);
  } finally {
    cleanup();
  }
  return 0;
}

// rethrow — re-raises past the current handler.
void propagate() {
  try {
    risky();
  } catch (e) {
    log(e);
    rethrow;
  }
}

// labeled break/continue across nested loops.
void labeled(List xs, List ys) {
  outer:
  for (var i in xs) {
    for (var j in ys) {
      if (match(i, j)) {
        break outer;
      }
      continue outer;
    }
  }
  done();
}

// harvest: var / final / typed locals, compound assign, member write (not a
// scalar def), null-coalescing (`??`) as a may-def, and a closure (own CFG).
int harvest(List xs, int? maybe) {
  var total = 0;
  final base = compute();
  int n = base ?? 1;
  total += base;
  xs.forEach((e) {
    total += e;
  });
  return n;
}

// assert may throw — modeled as a straight-line block with a handler edge.
void checked(bool ok) {
  assert(ok, 'must be ok');
  proceed();
}
