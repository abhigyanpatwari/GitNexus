extension Foo.Bar {
    func added() {
        // `self.base()` must resolve to Bar.base because `self == Bar` (the
        // TRAILING identifier of `Foo.Bar`). `added` must also hoist onto
        // Bar. Pre-fix, `extension Foo.Bar` re-keyed the extended type and
        // bound `self` to `Foo` (the LEADING identifier), so `self.base()`
        // resolved against `Foo` — which has no `base` — instead of Bar.
        self.base()
    }
}
