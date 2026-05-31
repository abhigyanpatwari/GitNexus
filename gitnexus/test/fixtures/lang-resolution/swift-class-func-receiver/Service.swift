class Service {
    var label: String = ""

    func handle() {
        // Service's instance method.
    }

    func instanceCaller() {
        // control: an instance method HAS a `self` receiver, so the
        // instance-property read `self.label` resolves with full
        // self-binding provenance.
        self.handle()
        let l = self.label
        _ = l
    }

    class func classCaller() {
        // `class func` is a TYPE method — it has NO `self` instance
        // receiver. Pre-fix, `class func` wrongly got a `self: Service`
        // instance binding, so `self.label` resolved with the SAME
        // high-confidence provenance as an instance method. Post-fix it
        // behaves exactly like `static func` (no instance self-binding).
        self.handle()
        let l = self.label
        _ = l
    }

    static func staticCaller() {
        // parity control: `static func` is a type method too (same rule);
        // its `self.label` provenance is the baseline `class func` must match.
        self.handle()
        let l = self.label
        _ = l
    }
}
