class User { void save() {} void store() {} }
class Other { void save() {} void store() {} }
class Factory { User make() { return null; } }
class OtherFactory { Other make() { return null; } }