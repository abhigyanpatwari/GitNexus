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
func measured() {}
func freeCaller() { touch(); measured() }
