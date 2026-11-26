// Swift CFG hazard fixture (#2195) — one of every control-flow shape the Swift
// CfgVisitor models, so the worker-roundtrip / integration passes exercise the
// real grammar end-to-end. Mirrors the sibling fixtures (go-hazards, rust-hazards).

import Foundation

// if / else + optional binding (`if let`)
func branching(_ x: Int, opt: Int?) -> Int {
    if x > 0 {
        positive()
    } else if x < 0 {
        negative()
    } else {
        zero()
    }
    if let y = opt {
        use(y)
    }
    return x
}

// guard let early-exit — the else MUST diverge, the body continues
func guarded(opt: Int?) -> Int {
    guard let value = opt else {
        return -1
    }
    guard ready() else {
        return -2
    }
    return value
}

// for-in / while / repeat-while (bottom-test) + `where`
func loops() {
    for item in collection where item > 0 {
        consume(item)
    }
    while running() {
        tick()
    }
    repeat {
        retry()
    } while shouldRetry()
}

// switch — no implicit fallthrough + explicit `fallthrough` + `where` guard
func dispatch(_ x: Int) {
    switch x {
    case 1:
        one()
        fallthrough
    case 2 where x > 0:
        two()
    case let n where n > 10:
        big(n)
    default:
        other()
    }
}

// do / catch (Swift error handling) with `try` / `try?` / `try!`
func errorHandling() {
    do {
        try risky()
        let cached = try? maybe()
        try! forced()
        deeper(cached)
    } catch let error {
        handle(error)
    } catch {
        fallbackHandler()
    }
    afterDo()
}

// defer — runs at scope exit, LIFO
func deferred() -> Int {
    defer { cleanupA() }
    defer { cleanupB() }
    let result = compute()
    return result
}

// labeled break / continue
func labeled() {
    outer: for i in rows {
        for j in cols {
            if skip(i, j) {
                continue outer
            }
            if stop(i, j) {
                break outer
            }
            process(i, j)
        }
    }
    done()
}

// `while true {}` — non-terminating; EXIT must stay reverse-reachable
func eventLoop(_ active: Bool) {
    while true {
        if active {
            poll()
        }
    }
}

// tuple destructuring + straight-line def/use
func destructure(pair: (Int, Int)) {
    let (a, b) = pair
    let sum = a + b
    use(sum)
}

// init / deinit are CFG-bearing
class Resource {
    var handle: Int

    init(handle: Int) {
        self.handle = handle
    }

    deinit {
        release(handle)
    }

    // a closure is its own CFG
    func register() {
        events.forEach { event in
            if event.isValid {
                accept(event)
            }
        }
    }
}
