// Go CFG hazard fixture (#2195 U5). Exercises every control-flow construct the
// Go visitor models, including the EXIT-reachability hazards (`for {}` /
// `select {}` with no default) the CDG soundness gate depends on. Used by the
// worker-mode PDG pipeline assertions and the cross-language CFG snapshot.
package hazards

import "errors"

// ifWithInitializer — `if init; cond { } else if { } else { }`.
func ifWithInitializer(x int) int {
	if v := x * 2; v > 0 {
		return v
	} else if v < 0 {
		return -v
	} else {
		return 0
	}
}

// forClause — C-style three-clause for, with continue/break.
func forClause(n int) int {
	sum := 0
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			continue
		}
		if i > 100 {
			break
		}
		sum += i
	}
	return sum
}

// forWhile — condition-only (while-style) loop.
func forWhile(x int) int {
	for x > 0 {
		x--
	}
	return x
}

// forRange — for-range over a slice; multi-return loop vars.
func forRange(xs []int) int {
	total := 0
	for k, v := range xs {
		total += k + v
	}
	return total
}

// forInfinite — `for {}` with no condition: NON-terminating shape. EXIT must
// stay reverse-reachable (structural exit edge) or CDG silently goes to zero.
func forInfinite(ch chan int) {
	for {
		v := <-ch
		if v < 0 {
			handle(v)
		}
	}
}

// exprSwitch — expression switch; cases do NOT fall through by default.
func exprSwitch(x int) string {
	switch x {
	case 1:
		return "one"
	case 2, 3:
		return "few"
	default:
		return "many"
	}
}

// explicitFallthrough — Go's EXPLICIT fallthrough (opposite of C).
func explicitFallthrough(x int) int {
	r := 0
	switch x {
	case 1:
		r = 1
		fallthrough
	case 2:
		r += 2
	default:
		r = -1
	}
	return r
}

// typeSwitch — type switch with an alias binding.
func typeSwitch(i interface{}) string {
	switch t := i.(type) {
	case int:
		return useInt(t)
	case string, []byte:
		return "str"
	default:
		return "other"
	}
}

// selectDispatch — select across communication cases (with default).
func selectDispatch(ch chan int, out chan int) {
	select {
	case v := <-ch:
		out <- v
	case out <- 0:
		sent()
	default:
		none()
	}
}

// selectBlocking — `select {}` with NO default blocks forever: EXIT must stay
// reverse-reachable (structural escape edge) or CDG silently goes to zero.
func selectBlocking(x bool) {
	if x {
		setup()
	}
	select {}
}

// deferLifo — deferred calls run at function return in LIFO order.
func deferLifo(path string) (err error) {
	defer first()
	defer second()
	f, e := open(path)
	if e != nil {
		return errors.New("open failed")
	}
	use(f)
	return nil
}

// labeledJumps — labeled break / continue / goto.
func labeledJumps(grid [][]int) int {
	found := -1
outer:
	for i := 0; i < len(grid); i++ {
		for j := 0; j < len(grid[i]); j++ {
			if grid[i][j] == 0 {
				continue outer
			}
			if grid[i][j] < 0 {
				found = i
				break outer
			}
		}
	}
	if found < 0 {
		goto done
	}
	report(found)
done:
	return found
}

// multiReturn — `a, b := f()` defines both names.
func multiReturn() int {
	a, b := pair()
	return a + b
}

// goroutine — `go func(){…}()` spawns a separate flow (not followed inline).
func goroutine(jobs chan int) {
	go func() {
		for j := range jobs {
			process(j)
		}
	}()
	go worker(1)
	after()
}

// Helper stubs so the fixture parses as a complete package.
func handle(v int)            {}
func useInt(t int) string     { return "" }
func sent()                   {}
func none()                   {}
func first()                  {}
func second()                 {}
func open(p string) (int, error) { return 0, nil }
func use(x int)               {}
func report(i int)            {}
func pair() (int, int)        { return 1, 2 }
func process(j int)           {}
func worker(n int)            {}
func after()                  {}
func setup()                  {}
