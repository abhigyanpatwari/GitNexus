class Base {
    func touch() {}
    func own() { touch() }
}
class Derived: Base {
    func inherited() { touch() }
}
class Other {
    func touch() {}
}
func sentinel() {}
func freeCaller() { touch(); sentinel() }
