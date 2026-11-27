package p;
class User { void save() {} int id() { return 0; } }
class Other { void save() {} int id() { return 0; } }
class Repo { Other other() { return null; } User user() { return null; } }
class Decoy { Other[] items() { return null; } }
@interface Ann {}