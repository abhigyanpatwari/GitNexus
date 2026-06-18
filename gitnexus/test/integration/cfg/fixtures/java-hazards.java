// Java CFG hazard fixture (#2195 U4). Each method exercises one control-flow
// construct the Java CfgVisitor models; the worker-mode pipeline + snapshot
// tests assert non-trivial BasicBlock / CFG / REACHING_DEF / CDG output here.
package fixtures;

import java.io.IOException;

class Hazards {

  // if / else — cond-true / cond-false to both arms, joining after.
  int branch(int x) {
    int r;
    if (x > 0) {
      r = 1;
    } else {
      r = 2;
    }
    return r;
  }

  // classic C-style for — init once, condition header, back-edge through update.
  int classicFor(int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
      sum += i;
    }
    return sum;
  }

  // enhanced for (for-each) — loop var def, iterated value use.
  int forEach(int[] xs) {
    int total = 0;
    for (int v : xs) {
      total += v;
    }
    return total;
  }

  // while — bottom-of-header re-test, back-edge.
  int whileLoop(int x) {
    while (x > 0) {
      x = step(x);
    }
    return x;
  }

  // do-while — body runs before the test.
  int doWhile(int x) {
    do {
      x = step(x);
    } while (x > 0);
    return x;
  }

  // try-with-resources — the resource closes on BOTH normal and exception exit
  // (finally semantics); a return inside crosses the close (finally-return).
  int withResources(String path) throws IOException {
    try (var r = open(path)) {
      return read(r);
    } catch (IOException e) {
      return handle(e);
    } finally {
      cleanup();
    }
  }

  // labeled break — `break outer;` from a nested loop targets the labeled frame.
  int labeledBreak(int[][] grid, int needle) {
    int found = -1;
    outer:
    for (int i = 0; i < grid.length; i++) {
      for (int j = 0; j < grid[i].length; j++) {
        if (grid[i][j] == needle) {
          found = i;
          break outer;
        }
      }
    }
    return found;
  }

  // classic colon switch — fallthrough between break-less cases; the case test
  // is recorded as a may-def on the dispatch block.
  int classicSwitch(int x) {
    int r = 0;
    switch (x) {
      case 1:
      case 2:
        r = 10;
        break;
      case 3:
        r = 30;
      default:
        r = -1;
    }
    return r;
  }

  // arrow switch — each rule rejoins after the switch (no fallthrough).
  int arrowSwitch(int x) {
    int r = 0;
    switch (x) {
      case 1 -> r = 1;
      case 2, 3 -> r = 2;
      default -> r = -1;
    }
    return r;
  }

  // switch expression with yield — yields a value to the enclosing switch.
  int yieldSwitch(int x) {
    int r = switch (x) {
      case 1 -> 10;
      default -> {
        yield 20;
      }
    };
    return r;
  }

  // synchronized — the monitor release is a deterministic finalizer.
  void sync(Object lock) {
    synchronized (lock) {
      touch();
    }
    after();
  }

  // a server-style non-terminating loop — EXIT must stay reverse-reachable so
  // CDG is not silently skipped for the method.
  void serve() {
    while (true) {
      if (ready()) {
        handle();
      }
    }
  }

  // helpers (no bodies of interest)
  int step(int x) { return x - 1; }
  Object open(String p) { return null; }
  int read(Object r) { return 0; }
  int handle(IOException e) { return 0; }
  void cleanup() {}
  void touch() {}
  void after() {}
  boolean ready() { return false; }
  void handle() {}
}
