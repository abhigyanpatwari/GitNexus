func processIfLet() {
    if let a = makeA(), let b = makeB() {
        a.m()
        b.shared()
    }
}

func processGuardLet() {
    guard let a = makeA(), let b = makeB() else { return }
    a.m()
    b.shared()
}
